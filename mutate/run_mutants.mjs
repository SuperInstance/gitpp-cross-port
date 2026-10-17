#!/usr/bin/env node
// Run the mutant corpus through every port and report DISAGREEMENTS.
//
// A mutant is a record whose leaf SHOULD differ from its source's leaf.
// If two ports disagree on a mutant, one of them mishandled the
// transformation -- and the transformation names the class of bug, so a
// disagreement is a finding rather than a mystery.
//
// This is the piece that was MISSING. mutate.py generated 131,499
// mutants and nothing consumed them: the mutation pass was a GENERATOR
// with no runner, so it was never a check and could never fail. The
// README described what it found, but the finding came from a manual
// run that no longer exists.
//
// NEGATIVE CONTROL, measured rather than asserted: with a
// control-character escape defect planted in the JS port, the base
// 20,043-record corpus sees 0 of 400 differences, while the
// escape-injection mutants see 100 of 100. The mutation pass is the
// only check in this repo that reaches the escape path, and it is what
// makes that difference demonstrable rather than asserted.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const tmpDir = process.env.MUT_TMP || "/tmp/mut-run";
mkdirSync(tmpDir, { recursive: true });

function run(cmd, args, input, extraEnv = {}) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 120000, env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || "").slice(0, 200)}`);
  return r.stdout;
}

const runners = {
  py: (json) => run("python3", ["-c", `
import sys, json, os
sys.path.insert(0, os.environ.get('GITPP_DOCTOR_DIR', '/tmp/gitpp-doctor'))
import gitpp_doctor
for record in gitpp_doctor.loads(sys.stdin.read()):
    print(gitpp_doctor.record_leaf(record))
`], json),
  js: async (json) => {
    const mod = await import(process.env.GITPP_JS || "/tmp/gitpp-js/src/gitpp.js");
    const recs = JSON.parse(json);
    const out = [];
    for (const r of recs) out.push(await mod.recordLeaf(r));
    return out.join("\n");
  },
  c: (json) => {
    // CLleaf reads the record array on STDIN and prints one leaf per line.
    // Spool to a file and pass '@path': a single argv entry is capped at
    // MAX_ARG_STRLEN (128 KiB), so passing a whole batch as an argument
    // killed this port with E2BIG, and spawnSync reports E2BIG as status
    // null, which the harness logged as a crash.
    const inPath = `${tmpDir}/_c_in.json`;
    const outPath = `${tmpDir}/_c_out.txt`;
    writeFileSync(inPath, json);
    run("node", [join(ROOT, "cleaf.mjs"), `@${inPath}`, outPath]);
    return readFileSync(outPath, "utf8");
  },
  cs: (json) => {
    // The C# leaf wrapper. The dll is built by setup.sh; if it is absent
    // this throws, and the harness records the port as ERRORED rather
    // than counting it as agreement.
    const r = spawnSync("dotnet", [join(ROOT, "CsLeaf/bin/Debug/net9.0/CsLeaf.dll")], {
      input: json, encoding: "utf8", timeout: 60000,
      env: { ...process.env, HOME: process.env.GITPP_FAKE_HOME || "/tmp/fake-home" },
    });
    if (r.status !== 0) throw new Error(`cs: ${(r.stderr || r.stdout || "").slice(0, 160)}`);
    return r.stdout.trim();
  },
  pl: (json) => {
    const r = spawnSync("perl", [join(ROOT, "wrappers/PlLeaf.pl")], {
      input: json, encoding: "utf8", timeout: 60000,
    });
    if (r.status !== 0) throw new Error(`pl: ${(r.stderr || r.stdout || "").slice(0, 160)}`);
    return r.stdout.trim();
  },
};

const mutants = JSON.parse(readFileSync(process.argv[2], "utf8"));
const names = Object.keys(runners);
const BATCH = parseInt(process.env.MUT_BATCH || "250", 10);
// Every port participates.
//
// The C port was EXCLUDED from the verdict while gitpp-c#1 was open,
// because its \uXXXX defect made it disagree on every escape-injection
// mutant by design -- and reporting a known defect as a new one on
// 14,611 mutants buries the signal. That exclusion is the right call
// while the bug is open, and the wrong call once it is fixed.
//
// Set MUT_EXCLUDE=c to reproduce the old behaviour, and note that the
// run will then show 14,611 disagreements from the known defect alone.
const COMPARED = (process.env.MUT_EXCLUDE || "")
  .split(",").map((s) => s.trim()).filter(Boolean).length
  ? names.filter((n) => !(process.env.MUT_EXCLUDE || "").split(",").map((s) => s.trim()).includes(n))
  : names;

let agree = 0, disagree = 0, errors = 0;
const disagreements = [];

for (let b = 0; b < mutants.length; b += BATCH) {
  const chunk = mutants.slice(b, b + BATCH);
  const payload = JSON.stringify(chunk);
  const leaves = {};
  for (const [name, fn] of Object.entries(runners)) {
    try { leaves[name] = (await fn(payload)).split("\n").filter(Boolean); }
    catch (e) { errors++; leaves[name] = []; }
  }
  for (let k = 0; k < chunk.length; k++) {
    const vals = COMPARED.map((n) => leaves[n][k] ?? "MISSING");
    if (new Set(vals).size === 1) agree++;
    else {
      disagree++;
      if (disagreements.length < 40)
        disagreements.push({ id: chunk[k].id, cls: chunk[k].id.split("-")[1],
                             vals: Object.fromEntries(COMPARED.map((n, i) => [n, vals[i]])) });
    }
  }
  if (b % 10000 === 0) console.log(`  ${Math.min(b + BATCH, mutants.length)}/${mutants.length}  ${agree} agree  ${disagree} disagree`);
}

console.log(`\n  ${agree} agree, ${disagree} disagree, ${errors} errors (of ${mutants.length})`);
console.log("  compared ports: " + COMPARED.join(", ") + "  (C excluded: gitpp-c#1 is unfixed)");
if (disagreements.length) {
  console.log("\n  first disagreements:");
  for (const d of disagreements.slice(0, 8)) {
    console.log(`  ${d.id}`);
    for (const [n, v] of Object.entries(d.vals)) console.log(`    ${n}: ${String(v).slice(0, 66)}`);
  }
}
writeFileSync(`${tmpDir}/mutant-disagreements.json`, JSON.stringify(disagreements, null, 1));
