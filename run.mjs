import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const CASES = "./cases";

async function* walk(dir) {
  for (const e of await import("node:fs/promises").then(m => m.readdir(dir, { withFileTypes: true }))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith(".json")) yield full;
  }
}

async function fetchLive() {
  const r = await fetch("https://gitpp.superinstance.dev/api/records?project=poc-quilt-1");
  if (!r.ok) throw new Error("fetch failed");
  return (await r.json()).records;
}

const INP = "/tmp/cross-port-bench/_input.json";
mkdirSync("/tmp/cross-port-bench", { recursive: true });

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000, ...opts });
  if (r.status !== 0) {
    throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 200)}`);
  }
  return r.stdout;
}

const runners = {
  py: async (records, at) => {
    writeFileSync(INP, JSON.stringify(records));
    const out = runSync("python3", ["./ports/python/gitpp_doctor.py", "explain", INP, "--at", at]);
    const j = JSON.parse(out);
    return j.closureRoot;
  },
  js: async (records, at) => {
    writeFileSync(INP, JSON.stringify(records));
    const out = runSync("node", ["./ports/javascript/bin/gitpp-js", INP, "--at", at]);
    const j = JSON.parse(out);
    return j.closureRoot;
  },
  cs: async (records, at) => {
    writeFileSync(INP, JSON.stringify(records));
    const out = runSync("dotnet", ["./ports/csharp/Test.dll", INP, "--at", at], { 
      env: { ...process.env, HOME: "/tmp/fake-home" } 
    });
    const j = JSON.parse(out);
    return j.closureRoot;
  },
  pl: async (records, at) => {
    writeFileSync(INP, JSON.stringify(records));
    const out = runSync("perl", ["./ports/perl/gitpp-pl", INP, "--at", at]);
    const j = JSON.parse(out);
    return j.closureRoot;
  }
};

const ports = ["py", "js", "cs", "pl"];
const live = await fetchLive();

const cases = [];
for await (const f of walk(CASES)) {
  cases.push({ file: f, name: basename(f, ".json"), json: JSON.parse(readFileSync(f, "utf8")) });
}

console.log(`Running ${cases.length} cases across ${ports.length} ports (${ports.join(", ")})...`);
const results = [];
for (const c of cases) {
  let records = c.json.input_tampered || c.json.input;
  if (!records && c.json.input_source === "live") records = live;
  if (!records) continue;
  const row = { name: c.name, at: c.json.at, ports: {} };
  for (const p of ports) {
    try {
      const root = await runners[p](records, c.json.at);
      row.ports[p] = { ok: true, root };
    } catch (e) {
      row.ports[p] = { ok: false, err: String(e.message).slice(0, 200) };
    }
  }
  results.push(row);
}

writeFileSync("/tmp/cross-port-bench/results.json", JSON.stringify(results, null, 2));

let allAgree = 0, disagree = 0, errors = 0;
for (const r of results) {
  const roots = Object.values(r.ports).filter(p => p.ok).map(p => p.root);
  const uniqueRoots = [...new Set(roots)];
  if (uniqueRoots.length === 1) {
    allAgree++;
  } else if (roots.length < ports.length) {
    errors++;
  } else {
    disagree++;
  }
}
console.log(`\nAgreement: ${allAgree} all-agree, ${disagree} disagree, ${errors} some-error`);

if (disagree > 0) {
  console.log("\nDisagreements:");
  for (const r of results) {
    const roots = Object.values(r.ports).filter(p => p.ok).map(p => p.root);
    if (new Set(roots).size > 1) {
      console.log(`  ${r.name} (at ${r.at}):`);
      for (const [p, data] of Object.entries(r.ports)) {
        console.log(`    ${p}: ${data.ok ? data.root : `ERR: ${data.err}`}`);
      }
    }
  }
}

if (errors > 0) {
  console.log("\nErrors:");
  for (const r of results) {
    for (const [p, data] of Object.entries(r.ports)) {
      if (!data.ok) console.log(`  ${r.name} on ${p}: ${data.err}`);
    }
  }
}
