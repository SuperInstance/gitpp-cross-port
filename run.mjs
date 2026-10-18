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

// The live fetch used to run UNCONDITIONALLY at startup, and a case whose
// input was missing was `continue`d -- so a deployment outage silently
// SHRANK the corpus and the run still reported a clean agreement count.
//
// Now: the fetch happens only if some case actually needs it, and if it
// fails the run FAILS LOUDLY rather than quietly testing fewer cases.
const fetchCache = new Map();
async function fetchFrom(url) {
  if (fetchCache.has(url)) return fetchCache.get(url);
  // The live endpoint was observed returning HTTP 503 intermittently
  // (HTTP 200 on the next request, same minute). So a fetch is RETRIED,
  // and a FAILURE IS NOT CACHED -- caching a transient 503 would poison
  // every remaining case and report a fleet-wide outage that was one
  // unlucky request.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const records = (await r.json()).records;
      if (!Array.isArray(records)) throw new Error("response has no records array");
      fetchCache.set(url, records);
      return records;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error("fetch from " + url + " failed after 3 attempts: " + String(lastErr && lastErr.message));
}
async function fetchLive() {
  return fetchFrom("https://gitpp.superinstance.dev/api/records?project=poc-quilt-1");
}

const INP = "/tmp/cross-port-bench/_input.json";
mkdirSync("/tmp/cross-port-bench", { recursive: true });

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000, ...opts });
  if (r.status !== 0) {
    // A PROTOCOL DIFFERENCE, NOT AN ERROR.
    //
    // The python reference's CLI signals an incomplete closure by exiting
    // non-zero and printing {"ok": false, "reason": "closure incomplete:
    // ..."}. The other four ports signal the SAME condition by exiting 0
    // and returning closureRoot: null.
    //
    // The corpus's own runner never sees this, because it calls the
    // python port's LIBRARY API rather than its CLI. The cross-port
    // harness drives CLIs, so it does see it -- and without this
    // normalisation the python port is recorded as an ERROR on the one
    // case that exercises spec S4, and the case can never agree.
    //
    // The rule is deliberately narrow: the body must parse as JSON, say
    // ok === false, and the reason must name an incomplete closure.
    // Anything else is still an error.
    const out = r.stdout || "";
    try {
      const j = JSON.parse(out);
      if (j && j.ok === false && /closure incomplete/i.test(String(j.reason || ""))) {
        return JSON.stringify({ __incompleteClosure: true, reason: j.reason });
      }
    } catch { /* not JSON: fall through to the error path */ }
    throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 200)}`);
  }
  return r.stdout;
}

const runners = {
  c: async (records, at) => {
    const INP = "./_input_c.json";
    writeFileSync(INP, JSON.stringify(records));
    const out = runSync("./ports/c/gitpp", [INP, "--at", at]);
    const j = JSON.parse(out);
    return j.closureRoot;
  },
  py: async (records, at) => {
    writeFileSync(INP, JSON.stringify(records));
    const out = runSync("python3", ["./ports/python/gitpp_doctor.py", "explain", INP, "--at", at]);
    const j = JSON.parse(out);
    // The marker runSync() sets for a non-zero exit that means "the
    // closure is incomplete" rather than "the port failed".
    if (j && j.__incompleteClosure) return null;
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

const ports = ["c", "py", "js", "cs", "pl"];

// The expected number of cases. A run that compared against NOTHING prints
// "0 all-agree, 0 disagree, 0 some-error", which reads exactly like a
// perfect run. The number of cases is now part of the verdict.
//
// 30 cases are discovered, but TWO of them cannot be tested by ANY
// runner: they carry an `input_modification` in prose ("Add a new record
// 'predecessor-1' that override-1 now depends on") and no
// `input_tampered`. The corpus's own runner skips them too, with the
// comment "Not yet implemented; case authors should provide
// input_tampered instead." So 28 are testable and 2 are a KNOWN gap.
//
// A known gap is NAMED, and any NEW gap is a FAILURE. A skip that is not
// one of the two known-unimplementable cases fails the run.
const EXPECTED_CASES = 30;
const MIN_TESTABLE_CASES = 28;

const cases = [];
for await (const f of walk(CASES)) {
  cases.push({ file: f, name: basename(f, ".json"), json: JSON.parse(readFileSync(f, "utf8")) });
}

console.log(`Running ${cases.length} cases across ${ports.length} ports (${ports.join(", ")})...`);
const results = [];
const skipped = [];
for (const c of cases) {
  let records = c.json.input_tampered || c.json.input;
  // THE INPUT-RESOLUTION BUG. This used to be:
  //     if (!records && c.json.input_source === "live") records = await fetchLive();
  // comparing input_source to the LITERAL STRING "live". But every live
  // case in the corpus sets input_source to a full URL:
  //     "input_source": "https://gitpp.superinstance.dev/api/records?project=poc-quilt-1"
  // so the comparison NEVER matched and those cases were silently
  // dropped. 10 of the 30 cases -- a third of the corpus -- were never
  // tested, and the run still printed a clean agreement count.
  //
  // The corpus's own runner gets this right:
  //     if (!records && c.input_source && c.input_source.startsWith("https://"))
  // Two runners implement the same corpus and the weaker one produced
  // this fleet's headline receipt. Now the weaker one reads the URL.
  if (!records && c.json.input_source && String(c.json.input_source).startsWith("https://")) {
    // A fetch failure must be a REPORTED CASE ERROR, not an unhandled
    // exception that kills the whole run and prints a stack trace. The
    // verdict below is far more useful than a crash.
    try {
      records = await fetchFrom(c.json.input_source);
    } catch (e) {
      skipped.push({ name: c.name, reason: "live fetch failed: " + String(e.message) });
      continue;
    }
  }
  if (!records) {
    // Previously `continue`d with no trace. A case that is silently dropped
    // is a case that is silently not tested, and the denominator shrinks
    // with it. Record it and let the verdict carry it.
    // The two cases that carry an `input_modification` and no
    // `input_tampered` are a KNOWN gap -- the corpus's own runner skips
    // them the same way. Any OTHER skip is a new gap and fails the run.
    const knownGap = !!c.json.input_modification && !c.json.input_tampered;
    skipped.push({
      name: c.name,
      known: knownGap,
      reason: knownGap
        ? "corpus case carries a prose input_modification and no input_tampered (known gap; the corpus's own runner skips it too)"
        : "no input records available",
    });
    continue;
  }
  const row = { name: c.name, at: c.json.at, ports: {} };
  for (const p of ports) {
    try {
      const root = await runners[p](records, c.json.at);
      // Port-vs-port agreement is NOT enough. All five ports could be
      // wrong in the same direction and the harness would call it a
      // perfect run. The corpus ALREADY encodes the spec-derived
      // expectation, so each port is checked against the SPEC as well
      // as against its siblings.
      //
      // expected_closure_root is one of:
      //   absent / "computed"  -- must be a 64-char lowercase hex
      //   "differs-from-pinned" -- must differ from the pinned values
      //   null                 -- must BE null (spec S4: an incomplete
      //                            closure has a null root)
      //   <hex>                -- must match exactly
      const exp = c.json.expected_closure_root;
      let specOk = true, specWhy = "";
      if (exp === undefined || exp === "computed") {
        specOk = typeof root === "string" && /^[a-f0-9]{64}$/.test(root);
        if (!specOk) specWhy = "expected a 64-char hex root, got " + JSON.stringify(root);
      } else if (exp === "differs-from-pinned") {
        specOk = typeof root === "string" && root !== c.json.pinned_root
               && root !== c.json.pinned_root_against_live;
        if (!specOk) specWhy = "expected a root differing from the pinned values, got " + JSON.stringify(root);
      } else if (exp === null) {
        specOk = root === null;
        if (!specOk) specWhy = "expected a NULL root (spec S4: incomplete closure), got " + JSON.stringify(root);
      } else {
        specOk = root === exp;
        if (!specOk) specWhy = "expected root " + exp + ", got " + JSON.stringify(root);
      }
      row.ports[p] = { ok: true, root, specOk, specWhy };
    } catch (e) {
      row.ports[p] = { ok: false, err: String(e.message).slice(0, 200) };
    }
  }
  results.push(row);
}

writeFileSync("/tmp/cross-port-bench/results.json", JSON.stringify(results, null, 2));

let allAgree = 0, disagree = 0, errors = 0;

// The old accounting was:
//
//   if (uniqueRoots.length === 1)      allAgree++;
//   else if (roots.length < ports.length) errors++;
//   else                               disagree++;
//
// which had THREE defects, all of them in the direction of looking green.
//
// (1) A case where 4 of 5 ports produced NO ANSWER AT ALL was counted as
//     ALL-AGREE, because the one surviving root was trivially "unique".
//     The absent reader counted as agreement -- the same bug this project
//     already found once, in the FOLD harness, rediscovered here
//     independently in the LEAF harness.
//
// (2) A DISAGREEMENT was only counted when every port answered. If any
//     port errored, the case was filed as an "error" and the disagreement
//     among the ports that DID answer was never counted at all. This is
//     precisely how a port returning a WRONG-but-well-formed root stays
//     invisible: a sibling port's error shields it.
//
// (3) "all-agree" never had to be reconciled against the number of cases,
//     so a run that compared against nothing looked identical to a
//     perfect run.
//
// Now: a port that errored is an ERROR for that case AND a disagreement
// among the survivors is counted INDEPENDENTLY. Both are reported. A
// case only counts as all-agree when EVERY port answered AND they all
// agree.
const disagreements = [];
for (const r of results) {
  const answered = Object.values(r.ports).filter(p => p.ok);
  const roots = answered.map(p => p.root);
  const uniqueRoots = [...new Set(roots)];
  const portErrors = ports.filter(p => !r.ports[p] || !r.ports[p].ok);

  if (uniqueRoots.length > 1) {
    disagree++;
    disagreements.push(r);
  }
  // A port that answers but answers WRONG is a disagreement with the
  // spec, even if every other port agrees with it.
  const specFails = ports.filter(p => r.ports[p] && r.ports[p].ok && !r.ports[p].specOk);
  if (specFails.length > 0) {
    disagree++;
    disagreements.push(r);
  }
  if (portErrors.length > 0) errors++;
  if (portErrors.length === 0 && uniqueRoots.length === 1) allAgree++;
}
console.log(`\nAgreement: ${allAgree} all-agree, ${disagree} disagree, ${errors} some-error`);
if (skipped.length) {
  const unknown = skipped.filter(sk => !sk.known);
  console.log(`Skipped: ${skipped.length} case(s) were never tested` +
    (unknown.length ? ` (${unknown.length} UNEXPECTED)` : " (all known gaps)"));
  for (const sk of skipped) console.log(`  ${sk.known ? "known gap" : "NEW GAP"}  ${sk.name}: ${sk.reason}`);
}

if (disagree > 0) {
  console.log("\nDisagreements:");
  for (const r of results) {
    const roots = Object.values(r.ports).filter(p => p.ok).map(p => p.root);
    const specFails = Object.entries(r.ports).filter(([, d]) => d.ok && !d.specOk);
    if (new Set(roots).size > 1 || specFails.length > 0) {
      console.log(`  ${r.name} (at ${r.at}):`);
      for (const [p, data] of Object.entries(r.ports)) {
        const line = data.ok ? data.root : `ERR: ${data.err}`;
        const specNote = data.ok && !data.specOk ? `   <-- SPEC: ${data.specWhy}` : "";
        console.log(`    ${p}: ${line}${specNote}`);
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

// THE EXIT CODE. There was none. The script printed its verdict and
// exited 0, so a CI that ran it was GREEN NO MATTER WHAT -- every port
// could error on every case and the badge would still be green.
//
// A harness that cannot fail is not evidence. This one now can.
const problems = [];
if (disagree > 0) problems.push(`${disagree} case(s) disagreed between ports`);
if (errors > 0) problems.push(`${errors} case(s) had a port error`);
const unknownSkips = skipped.filter(sk => !sk.known);
if (unknownSkips.length > 0) {
  problems.push(`${unknownSkips.length} case(s) were skipped for an UNEXPECTED reason: ` +
    unknownSkips.map(sk => sk.name).join(", "));
}
const knownSkips = skipped.length - unknownSkips.length;
if (results.length + knownSkips < MIN_TESTABLE_CASES) {
  problems.push(`only ${results.length} case(s) were compared (+${knownSkips} known gaps); ` +
    `expected at least ${MIN_TESTABLE_CASES}`);
}
if (cases.length < EXPECTED_CASES) {
  problems.push(`only ${cases.length} case(s) were discovered; expected ${EXPECTED_CASES}`);
}
if (allAgree !== results.length) {
  problems.push(`${allAgree} all-agree out of ${results.length} compared case(s)`);
}

if (problems.length) {
  console.log("\nFAIL");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nOK: every port answered every case and every case agreed.");
