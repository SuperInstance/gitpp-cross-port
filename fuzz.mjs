#!/usr/bin/env node
// Cross-port fuzz test runner.
// Reads records as raw text (NOT via JSON.parse) to preserve float64 precision.

import { readFileSync, writeFileSync } from "node:fs";
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
      else if (c === "\\\\") escape = true;
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
  const m = s.match(/"id"\\s*:\\s*"([^"]+)"/);
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
    writeFileSync(`${tmpDir}/_py_in.json`, "[" + recordJson + "]");
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
record = gitpp_doctor.loads(open('${tmpDir}/_py_in.json').read())[0]
print(gitpp_doctor.record_leaf(record))
`], { encoding: "utf8", timeout: 60000, env: process.env });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  },
  js: async (recordJson) => {
    writeFileSync(`${tmpDir}/_js_in.json`, "[" + recordJson + "]");
    const r = spawnSync("node", ["-e", `
import(process.env.GITPP_JS || "/tmp/gitpp-js/src/gitpp.js").then(async (mod) => {
  const fs = await import("node:fs");
  const records = JSON.parse(fs.readFileSync("${tmpDir}/_js_in.json", "utf8"));
  console.log(await mod.recordLeaf(records[0]));
});
`], { encoding: "utf8", timeout: 60000, env: process.env });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  },
  cs: async (recordJson) => {
    const r = spawnSync("dotnet", [join(ROOT, "CsLeaf/bin/Debug/net9.0/CsLeaf.dll")], {
      input: "[" + recordJson + "]",
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, HOME: "/tmp/fake-home" },
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  },
  pl: async (recordJson) => {
    const r = spawnSync("perl", [join(ROOT, "wrappers/PlLeaf.pl")], {
      input: "[" + recordJson + "]",
      encoding: "utf8",
      timeout: 60000,
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  },
  c: async (recordJson) => {
    const r = spawnSync(join(ROOT, "CLleaf"), [], {
      input: "[" + recordJson + "]",
      encoding: "utf8",
      timeout: 60000,
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  },
};

const ports = ["py", "js", "cs", "pl", "c"];

console.log("Running fuzz...");
const start = Date.now();
const results = [];
let i = 0;

for (let i = 0; i < recordJsonStrings.length; i++) {
  const recJson = recordJsonStrings[i];
  const id = recordIds[i];
  const row = { id, ports: {} };
  for (const p of ports) {
    try {
      const leaf = await runners[p](recJson);
      row.ports[p] = leaf;
    } catch (e) {
      row.ports[p] = `ERR: ${e.message.slice(0, 100)}`;
    }
  }
  results.push(row);
  if ((i+1) % 1000 === 0) console.log(`  ${i+1}/${recordJsonStrings.length}`);
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
console.log(`  ${agree} agree, ${disagree} disagree, ${errors} errors (out of ${results.length})`);

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
