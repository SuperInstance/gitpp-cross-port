#!/usr/bin/env node
// Cross-port fuzz test runner.
// Reads records as raw text (NOT via JSON.parse) to preserve float64 precision.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
      env: { ...process.env, HOME: "/tmp/fake-home" },
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

const ports = ["py", "js", "cs", "pl", "c"];

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
  const leaves = {};
  for (const [name, run] of Object.entries(runners)) {
    leaves[name] = (await run(payload)).split("\n").filter(Boolean);
  }
  for (let k = 0; k < chunk.length; k++) {
    const row = { id: `idx:${b + k}`, ports: {} };
    for (const name of Object.keys(runners)) row.ports[name] = leaves[name][k] ?? "MISSING";
    results.push(row);
  }
  const agree = results.filter((r) => new Set(Object.values(r.ports)).size === 1).length;
  console.log(`  ${Math.min(b + BATCH, recordJsonStrings.length)}/${recordJsonStrings.length}  ${agree} agree`);
}


const elapsed = ((Date.now() - start) / 1000).toFixed(1);

let agree = 0, disagree = 0, errors = 0;
const disagreements = [];
const errorSamples = [];
for (const r of results) {
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

console.log(`\nFuzz complete in ${elapsed}s`);
// Report the five PORTS and the REFERENCE separately. Folding the hub into a
// single "agree" number would make five conformant ports look broken because
// the reference diverges -- which is the opposite of what this suite is for.
const PORT_NAMES = ["py", "js", "cs", "pl", "c"];
const hasHub = Object.prototype.hasOwnProperty.call(runners, "hub");
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
  agree, disagree, errors,
  elapsed_seconds: parseFloat(elapsed),
  first_disagreements: disagreements.slice(0, 10),
  first_errors: errorSamples.slice(0, 3),
}, null, 2));
