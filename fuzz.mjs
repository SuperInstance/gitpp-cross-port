#!/usr/bin/env node
// Cross-port fuzz test runner.
// Reads records as raw text (NOT via JSON.parse) to preserve float64 precision.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { REQUIRED_PORTS, REFERENCE_PORTS, DEFAULT_PROBE, rosterCheck, reportRoster,
         fatalRoster, preflight, fatalPreflight, PortLedger, errText,
         declaredExclusions } from "./participants.mjs";

const recordsText = readFileSync(process.argv[2], "utf8");
console.log(`Records: ${recordsText.length} bytes`);

// Extract each record's raw JSON text using a careful walk
const recordJsonStrings = [];
{
  let i = 0;
  while (i < recordsText.length && recordsText[i] !== '[') i++;
  i++;
  let depth = 0, start = -1, inString = false, escape = false;
  for (; i < recordsText.length; i++) {
    const c = recordsText[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0) { recordJsonStrings.push(recordsText.slice(start, i + 1)); start = -1; } }
  }
}
console.log(`Found ${recordJsonStrings.length} records`);

// Build a simple id->index map by parsing just the id (use raw text scan)
const recordIds = [];
for (const s of recordJsonStrings) {
  const m = s.match(/"id"\s*:\s*"([^"]+)"/);
  recordIds.push(m ? m[1] : "?");
}

// Per-RUN scratch directory. The previous version wrote to a fixed
// /tmp/gitpp-fuzz/_py_in.json and _js_in.json. Two runs in the same sandbox
// (or a run overlapping a leftover process) then read each other's payloads,
// and the runner reported dozens of phantom disagreements that vanish on a
// clean re-run. A conformance test that cries wolf gets ignored; give every
// run its own directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const ROOT = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const tmpDir = mkdtempSync(join(tmpdir(), "gitpp-fuzz-"));
process.on("exit", () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

// Run-time resolution of the BEAM port's compiled modules. Same convention as
// GITPP_JS / GITPP_DOCTOR_DIR / GITPP_PL_DIR: an environment variable for the
// checkout under test, a sibling clone as the default.
const EX_EBIN = process.env.GITPP_EX_EBIN ||
  join(ROOT, "..", "gitpp-beam", "_build", "prod", "lib", "gitpp_beam", "ebin");
const exEbin = () => EX_EBIN;

const runners = {
  py: async (recordJson) => {
    writeFileSync(`${tmpDir}/_py_in.json`, recordJson);
    const r = spawnSync("python3", ["-c", `
import sys, json
import os; sys.path.insert(0, os.environ.get('GITPP_DOCTOR_DIR', '/tmp/gitpp-doctor'))
import gitpp_doctor
# Use the port's own decode entry point, NOT raw json.load. The port parses
# every JSON number into the float64 domain (parse_int=float); raw json.load
# leaves bare integer literals as arbitrary-precision ints, which is a
# different value for a different leaf. Testing the runner's idea of decoding
# instead of the port's is how 724818294626474393600 diverged while the
# suite kept reporting disagreement after the port was already fixed.
for record in gitpp_doctor.loads(open('${tmpDir}/_py_in.json').read()):
    print(gitpp_doctor.record_leaf(record))
`], { encoding: "utf8", timeout: 60000, env: process.env });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  },
  js: async (recordJson) => {
    writeFileSync(`${tmpDir}/_js_in.json`, recordJson);
    const r = spawnSync("node", ["-e", `
import(process.env.GITPP_JS || "/tmp/gitpp-js/src/gitpp.js").then(async (mod) => {
  const fs = await import("node:fs");
  const records = JSON.parse(fs.readFileSync("${tmpDir}/_js_in.json", "utf8"));
  for (const r of records) console.log(await mod.recordLeaf(r));
});
`], { encoding: "utf8", timeout: 60000, env: process.env });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  },
  cs: async (recordJson) => {
    const r = spawnSync("dotnet", [join(ROOT, "CsLeaf/bin/Debug/net9.0/CsLeaf.dll")], {
      input: recordJson,
      encoding: "utf8",
      timeout: 60000,
      // A fake HOME, so the port cannot pick up a stray dotfile. It is
      // applied on TOP of the real environment rather than replacing it,
      // which is what a spread of process.env already did -- the spread
      // was correct, but the fake HOME alone meant the port could not
      // see GITPP_* overrides, and a reader that could not see its
      // overrides silently fell back to a hardcoded path.
      env: { ...process.env, HOME: process.env.GITPP_FAKE_HOME || "/tmp/fake-home" },
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  },
  pl: async (recordJson) => {
    const r = spawnSync("perl", [join(ROOT, "wrappers/PlLeaf.pl")], {
      input: recordJson,
      encoding: "utf8",
      timeout: 60000,
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  },
  // Elixir/OTP 27 (gitpp-beam, the sixth port and the only one written by a
  // different organisation). The port is loaded from a COMPILED ebin dir, the
  // same run-time indirection the other five wrappers use, so CI and a local
  // checkout differ by an environment variable and not by a hardcoded path.
  //
  // It needs OTP 27 and Elixir 1.17: canon.ex uses a runtime-sized binary
  // segment (<<...::binary-size(^decpt), ...>>), which is 1.17 syntax. The
  // apt Elixir (1.14 on ubuntu-22.04/24.04) cannot compile this port at all.
  ex: async (recordJson) => {
    const r = spawnSync("elixir", ["-pa", exEbin(), join(ROOT, "wrappers/ElixirLeaf.exs")], {
      input: recordJson,
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, ELIXIR_ERL_OPTIONS: process.env.ELIXIR_ERL_OPTIONS || "+fnu",
             LANG: process.env.LANG || "C.UTF-8" },
    });
    // ENOENT (no `elixir` on PATH) arrives as r.error with status null. Without
    // this branch it is reported as "exit null", which names neither the port
    // nor the cause.
    if (r.error) throw new Error(`ex port: elixir not runnable (${errText(r.error)}) -- need OTP 27 + Elixir 1.17 on PATH`);
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop() || `ex port exited ${r.status}`);
    return r.stdout.trim();
  },
  c: async (recordJson) => {
    // CLleaf reads the record array on STDIN and prints one leaf per line.
    // Spool to a file and pass '@path'. A single argv entry is capped at
    // MAX_ARG_STRLEN (128 KiB on Linux), so passing the whole batch as an
    // argument killed this port with E2BIG at BATCH=2000 -- and spawnSync
    // reports E2BIG as status null, which the harness logged as a crash.
    // Every other runner already spools or uses stdin.
    writeFileSync(`${tmpDir}/_c_in.json`, recordJson);
    const r = spawnSync("node", [join(ROOT, "cleaf.mjs"), `@${tmpDir}/_c_in.json`, `${tmpDir}/_c_out.txt`], {
      encoding: "utf8", timeout: 60000, env: process.env,
    });
    if (r.error) throw new Error(`c port: ${r.error.code || r.error.message}`);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return readFileSync(`${tmpDir}/_c_out.txt`, "utf8").trim();
  },
};

// The TypeScript hub, compiled to ESM (tsc -> HUB_BUILD). It is the reference
// implementation, so excluding it would mean "all ports agree" is a claim only
// about the ports. It diverges from all five on 448/20,043 today
// (patchwork-quilt/git.pp-ng#28) and the suite must be able to SEE that rather
// than have it hidden by construction.
const HUB_BUILD = process.env.HUB_BUILD || "/tmp/hub-build/fold.js";
if (existsSync(HUB_BUILD)) {
  runners.hub = async (payloadText) => {
    const inPath = `${tmpDir}/_hub_in.json`;
    const outPath = `${tmpDir}/_hub_out.txt`;
    writeFileSync(inPath, payloadText);
    const r = spawnSync("node", [join(ROOT, "hubleaf.mjs"), inPath, outPath], {
      encoding: "utf8", timeout: 60000, env: process.env,
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return readFileSync(outPath, "utf8").trim();
  };
}

// ---------------------------------------------------------------------------
// PARTICIPANT ROSTER + PREFLIGHT
//
// Both are new. Before them, a port that could not run was either a whole-run
// crash (port cannot load) or 20,043 fabricated "disagreements" plus exit 0
// (port prints nothing). See participants.mjs for the measured before/after.
// The roster is checked BEFORE the corpus is read, and the preflight runs six
// tiny probes before the first batch, so a sixth port that cannot start costs
// three seconds instead of the entire run.
const EXCLUDED = declaredExclusions();
const roster = rosterCheck(runners, { excluded: EXCLUDED });
console.log(reportRoster(roster, "fuzz"));
if (!roster.ok) process.exit(fatalRoster(roster, "fuzz"));

if (!existsSync(exEbin())) {
  console.error(`\n${"=".repeat(72)}`);
  console.error("FATAL: fuzz -- the Elixir port's compiled modules are not present.");
  console.error("=".repeat(72));
  console.error(`  expected at: ${exEbin()}`);
  console.error("  set GITPP_EX_EBIN, or build it:  (cd ../gitpp-beam && MIX_ENV=prod mix compile)");
  console.error("  without them this port would answer every record with 'MISSING',");
  console.error("  which the harness would report as 20,043 port disagreements and exit 0.\n");
  process.exit(1);
}

const pre = await preflight(runners, { excluded: EXCLUDED, probe: DEFAULT_PROBE, label: "fuzz" });
if (!pre.ok) process.exit(fatalPreflight(pre, "fuzz"));
console.log(`fuzz: preflight ok -- all ${pre.probed.length} ports produced ${pre.probeRecords} leaves`);

const ledger = new PortLedger();

console.log("Running fuzz...");
const start = Date.now();
const results = [];
let i = 0;

// BATCHED. Spawning five processes PER RECORD is 100,215 process starts for
// a 20,043-record corpus, at ~0.55s/record -- 3 hours. The per-record spawn
// is the entire cost; the ports themselves are microseconds. Chunking turns
// that into 5 x (N/BATCH) starts. A batch of 250 turns 3 hours into ~90s.
const BATCH = parseInt(process.env.FUZZ_BATCH || "250", 10);

for (let b = 0; b < recordJsonStrings.length; b += BATCH) {
  const chunk = recordJsonStrings.slice(b, b + BATCH);
  const payload = "[" + chunk.join(",") + "]";
  // A port that throws or prints the wrong number of leaves must not become a
  // value in the comparison. It marks the batch INVALID: the rows are kept for
  // the report but counted as neither agreement nor disagreement, and the run
  // exits non-zero at the end. Previously `leaves[name][k] ?? "MISSING"` did
  // the opposite -- it turned an absent port into 20,043 disagreements.
  const leaves = {};
  let batchInvalid = false;
  for (const [name, run] of Object.entries(runners)) {
    let out;
    try {
      out = await run(payload);
    } catch (e) {
      ledger.fail(name, `batch starting at record ${b}: ${errText(e)}`);
      batchInvalid = true;
      continue;
    }
    const lines = String(out).split("\n").filter(Boolean);
    ledger.record(name, lines.length);
    if (lines.length !== chunk.length) {
      ledger.fail(name, `batch starting at record ${b}: printed ${lines.length} leaves for ${chunk.length} records` +
        (lines.length === 0 ? " (loaded and printed nothing)" : ""));
      batchInvalid = true;
    }
    leaves[name] = lines;
  }
  if (batchInvalid) ledger.invalidBatches++;

  for (let k = 0; k < chunk.length; k++) {
    const row = { id: `idx:${b + k}`, ports: {}, invalid: batchInvalid };
    for (const name of Object.keys(runners)) row.ports[name] = leaves[name]?.[k] ?? "MISSING";
    results.push(row);
  }
  const agree = results.filter((r) => !r.invalid && new Set(Object.values(r.ports)).size === 1).length;
  console.log(`  ${Math.min(b + BATCH, recordJsonStrings.length)}/${recordJsonStrings.length}  ${agree} agree` +
    (batchInvalid ? "  [batch invalid: participant failure]" : ""));
}


const elapsed = ((Date.now() - start) / 1000).toFixed(1);

let agree = 0, disagree = 0, errors = 0, notCompared = 0;
const disagreements = [];
const errorSamples = [];
for (const r of results) {
  // Rows from an invalid batch are counted as NOT COMPARED. They are not
  // agreement and they are not a port disagreement: the comparison never
  // happened, and the denominator that survives into the summary is smaller
  // than the corpus by an amount this harness prints.
  if (r.invalid) { notCompared++; continue; }
  const leaves = Object.values(r.ports).filter(v => !v.startsWith("ERR:"));
  const errs = Object.values(r.ports).filter(v => v.startsWith("ERR:")).length;
  const uniq = [...new Set(leaves)];
  if (errs > 0) {
    errors++;
    if (errorSamples.length < 3) errorSamples.push(r);
  }
  if (uniq.length === 1 && errs === 0) agree++;
  else if (uniq.length > 1) {
    disagree++;
    if (disagreements.length < 10) disagreements.push(r);
  }
}

if (!ledger.ok) {
  console.error(`\n${"=".repeat(72)}`);
  console.error(`FATAL: fuzz -- ${ledger.failures.size} participant(s) failed during the run.`);
  console.error("=".repeat(72));
  console.error(ledger.report("fuzz"));
  console.error(`\n${notCompared} record(s) were NOT compared and are excluded from every number above.`);
  console.error("They are reported here because a smaller denominator that nobody sees\n" +
                "is the failure this check exists to prevent.\n");
}
console.log(`\nFuzz complete in ${elapsed}s`);
// Report the five PORTS and the REFERENCE separately. Folding the hub into a
// single "agree" number would make five conformant ports look broken because
// the reference diverges -- which is the opposite of what this suite is for.
// DERIVED from the runner table, minus the reference ports. This was a second
// hand-written list -- adding a sixth port to `runners` without also editing
// this array would have left the "ports agree with each other" line silently
// measuring five ports while the roster claimed six. Two lists for one fact is
// exactly how a participant goes missing without anyone noticing.
const PORT_NAMES = Object.keys(runners).filter((n) => !REFERENCE_PORTS.includes(n));
const hasHub = Object.prototype.hasOwnProperty.call(runners, "hub");

// The reference is registered only when a build exists, which IS a silent
// drop -- and it is allowed here because the hub is not a port and its
// absence changes what "agree" means. It is stated on stdout rather than
// inferred from a missing line.
if (!hasHub) {
  console.log(`  hub (ref) : ABSENT -- no build at ${HUB_BUILD}; the reference line is missing for that stated reason`);
}
if (hasHub) {
  const portAgree = results.filter((r) => {
    const v = PORT_NAMES.map((p) => r.ports[p]);
    return v.every((x) => x === v[0]);
  }).length;
  const hubAgree = results.filter((r) => {
    const portVals = PORT_NAMES.map((p) => r.ports[p]);
    return r.ports.hub === portVals[0];
  }).length;
  console.log(`  ports     : ${portAgree}/${results.length} agree with each other`);
  console.log(`  hub (ref) : ${hubAgree}/${results.length} agree with the ports  <- measured, see git.pp-ng#28`);
} else {
  console.log(`  ${agree} agree, ${disagree} disagree, ${errors} errors (out of ${results.length})`);
}
if (notCompared) console.log(`  not compared: ${notCompared} (participant failure; see above)`);

if (errorSamples.length > 0) {
  console.log("\nError samples:");
  for (const e of errorSamples) {
    console.log(`  ${e.id}:`);
    for (const [p, l] of Object.entries(e.ports)) {
      console.log(`    ${p}: ${l.slice(0, 100)}`);
    }
  }
}

if (disagreements.length > 0) {
  console.log("\nFirst disagreements:");
  for (const d of disagreements.slice(0, 5)) {
    console.log(`  ${d.id}:`);
    for (const [p, l] of Object.entries(d.ports)) {
      console.log(`    ${p}: ${l.slice(0, 50)}`);
    }
  }
}

writeFileSync(`${ROOT}/results.json`, JSON.stringify({
  total: results.length,
  // The roster goes in the artifact. A results.json that says "agree" without
  // saying over WHICH ports is the file version of the bug this file fixed.
  ports: PORT_NAMES,
  reference_ports: hasHub ? ["hub"] : [],
  required_ports: REQUIRED_PORTS,
  excluded_ports: EXCLUDED,
  participant_failures: ledger.summary(),
  agree, disagree, errors,
  // Denominator arithmetic, always present so it cannot be inferred.
  records_compared: agree + disagree + errors,
  records_not_compared: notCompared,
  elapsed_seconds: parseFloat(elapsed),
  first_disagreements: disagreements.slice(0, 10),
  first_errors: errorSamples.slice(0, 3),
}, null, 2));

// A fuzz run that cannot compare every record over every declared port is a
// FAILURE. It used to exit 0 unconditionally, so "the sixth port is broken"
// was indistinguishable from "the sixth port agrees".
if (!ledger.ok || !roster.ok) process.exit(1);
