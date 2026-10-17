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
import { REQUIRED_PORTS, DEFAULT_PROBE, rosterCheck, reportRoster, fatalRoster,
         preflight, fatalPreflight, PortLedger, errText,
         declaredExclusions } from "../participants.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Same run-time indirection as fuzz.mjs: GITPP_EX_EBIN, else a sibling clone.
const EX_EBIN = process.env.GITPP_EX_EBIN ||
  join(ROOT, "..", "gitpp-beam", "_build", "prod", "lib", "gitpp_beam", "ebin");
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
  // Elixir/OTP 27 (gitpp-beam). Needs OTP 27 + Elixir 1.17 on PATH: the port
  // uses a runtime-sized binary segment, which is 1.17 syntax, so the apt
  // Elixir cannot compile it. +fnu keeps filename encoding consistent with the
  // other UTF-8 paths in this run.
  ex: (json) => {
    const r = spawnSync("elixir", ["-pa", EX_EBIN, join(ROOT, "wrappers/ElixirLeaf.exs")], {
      input: json, encoding: "utf8", timeout: 120000,
      env: { ...process.env, ELIXIR_ERL_OPTIONS: process.env.ELIXIR_ERL_OPTIONS || "+fnu",
             LANG: process.env.LANG || "C.UTF-8" },
    });
    if (r.error) throw new Error(`ex: elixir not runnable (${errText(r.error)}) -- need OTP 27 + Elixir 1.17 on PATH`);
    if (r.status !== 0) throw new Error(`ex: ${(r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop() || `exit ${r.status}`}`);
    return r.stdout.trim();
  },
};

// ---------------------------------------------------------------------------
// PARTICIPANT ROSTER + PREFLIGHT (new)
//
// THIS WAS THE HARNESS THAT DROPPED A PORT SILENTLY. Measured, with the C
// port made unable to produce a leaf, on the 200-mutant slice:
//
//   0 agree, 200 disagree, 1 errors (of 200)
//   compared ports: py, js, c, cs, pl  (C excluded: gitpp-c#1 is unfixed)
//   exit 0
//
// A port that computed NOTHING was reported as 200 disagreements, the roster
// line named it as a participant, `errors` counted BATCHES rather than ports
// so it never said which one, and the run passed. `catch (e) { errors++;
// leaves[name] = [] }` turned an absent port into the literal string
// "MISSING" for every record, which then disagreed with five correct leaves.
//
// Both failures are now fatal before the corpus is touched, and a mid-run
// failure marks its batch invalid instead of fabricating disagreements.
const EXCLUDED = declaredExclusions();
const roster = rosterCheck(runners, { excluded: EXCLUDED });
console.log(reportRoster(roster, "mutate"));
if (!roster.ok) process.exit(fatalRoster(roster, "mutate"));

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

const pre = await preflight(runners, { excluded: EXCLUDED, probe: DEFAULT_PROBE, label: "mutate" });
if (!pre.ok) process.exit(fatalPreflight(pre, "mutate"));
console.log(`mutate: preflight ok -- all ${pre.probed.length} ports produced ${pre.probeRecords} leaves`);

const ledger = new PortLedger();
let agree = 0, disagree = 0, notCompared = 0;
const disagreements = [];
// EVERY disagreeing mutant, with its class. Bounded by the corpus, not by the
// print sample.
const classTally = [];

for (let b = 0; b < mutants.length; b += BATCH) {
  const chunk = mutants.slice(b, b + BATCH);
  const payload = JSON.stringify(chunk);
  const leaves = {};
  let batchInvalid = false;
  for (const [name, fn] of Object.entries(runners)) {
    let out;
    try { out = await fn(payload); }
    catch (e) {
      ledger.fail(name, `batch starting at mutant ${b}: ${errText(e)}`);
      batchInvalid = true;
      continue;
    }
    const lines = String(out).split("\n").filter(Boolean);
    ledger.record(name, lines.length);
    if (lines.length !== chunk.length) {
      ledger.fail(name, `batch starting at mutant ${b}: printed ${lines.length} leaves for ${chunk.length} mutants` +
        (lines.length === 0 ? " (loaded and printed nothing)" : ""));
      batchInvalid = true;
    }
    leaves[name] = lines;
  }
  if (batchInvalid) ledger.invalidBatches++;

  for (let k = 0; k < chunk.length; k++) {
    // Invalid batches are NOT disagreements. They are records this harness
    // declined to compare, and they are counted and printed as such, so the
    // denominator in the summary always says how many records it actually
    // compared.
    if (batchInvalid) { notCompared++; continue; }
    const vals = COMPARED.map((n) => leaves[n][k] ?? "MISSING");
    if (new Set(vals).size === 1) agree++;
    else {
      disagree++;
      classTally.push({ cls: (chunk[k].id.match(/^mut-(.+?)-(?:rec|splitter|intlit|intstr|intflt)-[0-9a-z]+$/) || [])[1] || chunk[k].id.split("-")[1],
                        vals: Object.fromEntries(COMPARED.map((n, i) => [n, vals[i]])) });
      if (disagreements.length < 40)
        disagreements.push({
          id: chunk[k].id,
          // The FULL mutation class, not id.split("-")[1]. Ids look like
          // `mut-float-mantissa-flip-rec-123`, so the old expression lumped
          // float-mantissa-flip and float-regime into one "float" bucket and a
          // per-class report built on it would have been wrong by construction.
          cls: (chunk[k].id.match(/^mut-(.+?)-(?:rec|splitter|intlit|intstr|intflt)-[0-9a-z]+$/) || [])[1] || chunk[k].id.split("-")[1],
          vals: Object.fromEntries(COMPARED.map((n, i) => [n, vals[i]])),
        });
    }
  }
  if (b % 10000 === 0) console.log(`  ${Math.min(b + BATCH, mutants.length)}/${mutants.length}  ${agree} agree  ${disagree} disagree` +
    (batchInvalid ? "  [batch invalid]" : ""));
}

// Per-CLASS disagreement tally, over EVERY disagreeing mutant, not the 40
// sampled for printing.
//
// "A mutant pass agrees on 131,499 mutants" is a much weaker claim than "it
// agrees on each of the nine transformation classes": a whole class can fail
// while the total still looks like a number someone would recognise. The
// sampled `disagreements` array capped at 40, so any per-class report derived
// from it was a lower bound of unknown tightness -- and the class field it used,
// id.split("-")[1], lumped float-mantissa-flip together with float-regime.
const byClass = {};
const portsByClass = {};
for (const { cls, vals } of classTally) {
  const row = byClass[cls] || (byClass[cls] = { total: 0, ports: {} });
  row.total++;
  for (const [p, v] of Object.entries(vals)) {
    const majority = majorityOf(vals);
    if (v !== majority) row.ports[p] = (row.ports[p] || 0) + 1;
  }
  portsByClass[cls] = row.ports;
}

// The port that disagrees, per class. Computed against the MAJORITY so a
// minority port is named as the outlier rather than merely "some port".
function majorityOf(vals) {
  const counts = {};
  for (const v of Object.values(vals)) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

if (!ledger.ok) {
  console.error(`\n${"=".repeat(72)}`);
  console.error(`FATAL: mutate -- ${ledger.failures.size} participant(s) failed during the run.`);
  console.error("=".repeat(72));
  console.error(ledger.report("mutate"));
  console.error(`\n${notCompared} mutant(s) were NOT compared and are excluded from every number above.`);
  console.error("");
}

console.log(`\n  ${agree} agree, ${disagree} disagree, ${notCompared} not compared (of ${mutants.length})`);
console.log("  compared ports: " + COMPARED.join(", "));
// The exclusion notice used to be printed UNCONDITIONALLY, so a run that
// excluded nothing still claimed "C excluded: gitpp-c#1 is unfixed".
const dropped = names.filter((n) => !COMPARED.includes(n));
if (dropped.length) console.log(`  excluded from the comparison: ${dropped.join(", ")}`);
if (Object.keys(byClass).length) {
  console.log("\n  per class (complete over the corpus):");
  for (const [cls, row] of Object.entries(byClass).sort()) {
    const who = Object.entries(row.ports).map(([p, n]) => `${p}:${n}`).join(" ") || "(none)";
    console.log(`    ${cls.padEnd(22)} ${String(row.total).padStart(6)} disagree   ${who}`);
  }
}
if (disagreements.length) {
  console.log("\n  first disagreements:");
  for (const d of disagreements.slice(0, 8)) {
    console.log(`  ${d.id}`);
    for (const [n, v] of Object.entries(d.vals)) console.log(`    ${n}: ${String(v).slice(0, 66)}`);
  }
}
writeFileSync(`${tmpDir}/mutant-disagreements.json`, JSON.stringify(disagreements, null, 1));
writeFileSync(`${tmpDir}/mutant-summary.json`, JSON.stringify({
  total: mutants.length,
  ports: COMPARED,
  required_ports: REQUIRED_PORTS,
  excluded_ports: EXCLUDED,
  participant_failures: ledger.summary(),
  agree, disagree, not_compared: notCompared,
  records_compared: agree + disagree,
  // Complete over the corpus, not over the print sample.
  disagreements_by_class: byClass,
  // The port that disagrees, per class, against the majority leaf.
  disagreeing_ports_by_class: portsByClass,
  sample_printed_up_to: disagreements.length,
}, null, 2));

// A participant that cannot run is a FAILURE. This harness used to exit 0
// unconditionally, which is why a sixth port that could not load would have
// been reported as 131,499 disagreements and still passed CI.
if (!ledger.ok || !roster.ok || disagree > 0) process.exit(1);
