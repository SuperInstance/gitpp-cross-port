// Participant accounting for the cross-port harnesses.
//
// THE QUESTION THIS FILE EXISTS TO ANSWER
// --------------------------------------
// "Does the harness report a port that cannot run, or does it quietly drop it?"
//
// Measured on the harnesses before this file existed, by making a port
// unloadable and by making one print nothing:
//
//   port cannot load  -> the runner throws, `await` rejects, the whole fuzz
//                        run dies on an unhandled rejection. Exit 1, no
//                        results.json, no summary, and the only mention of
//                        WHICH port is a line of a Node stack trace.
//   port prints nothing -> every leaf for that port becomes the literal string
//                        "MISSING", which is then compared against the other
//                        ports' real leaves and reported as a PORT
//                        DISAGREEMENT. fuzz.mjs printed
//                            0 agree, 200 disagree, 0 errors (out of 200)
//                        -- "0 errors", because `errors` only counts the hub's
//                        "ERR:" prefix, which the six real ports never emit --
//                        and exited 0. run_mutants.mjs printed
//                            0 agree, 200 disagree, 1 errors (of 200)
//                            compared ports: py, js, c, cs, pl
//                        -- a confident roster naming a port that computed
//                        nothing -- and also exited 0.
//
// So: a missing port was reported as if it were a wrong port, and a harness
// that could not tell the difference passed CI. Both harnesses now go through
// the three checks here, and all three are mutation-tested:
//
//   1. ROSTER   every REQUIRED port must be present in the runner table, and
//               anything else present must be accounted for. Catches the
//               silent drop -- the `if (existsSync(...)) runners.x = ...`
//               shape, which is how `hub` is registered in fuzz.mjs and how a
//               sixth port would have been registered naively.
//   2. PREFLIGHT every required port is run ONCE on a fixed probe before the
//               corpus is touched, and must return exactly one leaf per probe
//               record. Catches "cannot load" and "loads but silent" in ~3
//               seconds instead of after 20,043 records, and names the port.
//   3. ACCOUNTING a port that fails or returns the wrong number of leaves on
//               any batch marks that batch INVALID. Invalid rows are counted
//               as neither agreement nor disagreement, are reported as
//               `records_not_compared`, and force a non-zero exit. The
//               denominator can never shrink quietly: it is printed.
//
// The roster is a reviewed constant. Dropping a port from a cross-port suite
// is a decision that should show up in a diff, not an accident that shows up
// as a smaller number.

/**
 * Ports every cross-port run in this repo is required to have.
 *
 * The ORDER is the report order and is part of the reviewed roster: changing
 * it changes published output. `ex` is patchwork-quilt/gitpp-beam, the sixth
 * port and the only one written by a different organisation.
 */
export const REQUIRED_PORTS = ["py", "js", "cs", "pl", "c", "ex"];

/**
 * Ports that are NOT leaf ports: the TypeScript reference implementation,
 * registered only when a build of it exists. Reported separately from the
 * ports everywhere, because folding a diverging reference into one "agree"
 * number makes six conformant ports look broken.
 */
export const REFERENCE_PORTS = ["hub"];

const DEFAULT_PROBE = JSON.stringify([
  { id: "probe-a", kind: "task", parents: [], reason: null,
    effects: { x: 1e-5, big: 724818294626474393600, s: "ab", n: null, t: true } },
  { id: "probe-b", kind: "task", parents: [], reason: null,
    effects: { z: -0.0, nested: { k: [1, 2] }, neg: -1 } },
]);
export { DEFAULT_PROBE };

/** A leaf is 64 lowercase hex characters. Used to reject a port's debug output. */
export const LEAF_RE = /^[0-9a-f]{64}$/;

/**
 * The declared opt-out. A port may be excluded, but only by name, in one
 * variable, and every run prints who was excluded and why it was allowed.
 * There is no silent path: if a port is in REQUIRED_PORTS and not in the
 * exclusion list, it must be in the runner table.
 */
export function declaredExclusions(env = process.env) {
  const raw = [env.GITPP_EXCLUDE, env.MUT_EXCLUDE, env.FUZZ_EXCLUDE].filter(Boolean).join(",");
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Check 1: the runner table covers exactly the required roster. */
export function rosterCheck(runners, { required = REQUIRED_PORTS, excluded = [] } = {}) {
  const present = Object.keys(runners);
  const want = required.filter((p) => !excluded.includes(p));
  return {
    missing: want.filter((p) => !present.includes(p)),
    excluded: required.filter((p) => excluded.includes(p)),
    unexpected: present.filter((p) => !want.includes(p) && !REFERENCE_PORTS.includes(p)),
    reference: present.filter((p) => REFERENCE_PORTS.includes(p)),
    ok: want.every((p) => present.includes(p)),
    want,
  };
}

export function reportRoster(r, label) {
  const lines = [`${label}: required ports [${r.want.join(", ")}]`];
  if (r.reference.length) lines.push(`${label}: reference  [${r.reference.join(", ")}] (reported separately)`);
  if (r.excluded.length) lines.push(`${label}: EXCLUDED by declaration: [${r.excluded.join(", ")}]`);
  if (r.missing.length) lines.push(`${label}: MISSING PARTICIPANT(S): [${r.missing.join(", ")}]`);
  if (r.unexpected.length) lines.push(`${label}: unregistered port(s) in the runner table: [${r.unexpected.join(", ")}]`);
  return lines.join("\n");
}

export function fatalRoster(r, label) {
  console.error(`\n${"=".repeat(72)}`);
  console.error(`FATAL: ${label} cannot run over ${r.missing.length ? r.missing.length : r.unexpected.length} fewer port(s) than it claims.`);
  console.error(`${"=".repeat(72)}`);
  console.error(reportRoster(r, label));
  console.error(
    "\nA port that cannot load is a FAILURE, not a smaller denominator. A run over\n" +
    "five ports reports the same 'agree' count as a run over six, so the number\n" +
    "cannot distinguish them -- only an explicit roster can. Fix the port's load\n" +
    "path, or declare the exclusion by name in GITPP_EXCLUDE and have it printed."
  );
  console.error("");
  return 1;
}

/** Trim a thrown value down to one legible line. Spawn failures are the common case. */
export function errText(e) {
  if (e && e.code) return `${e.code}`;
  const s = String((e && e.message) || e || "unknown error").trim();
  const last = s.split("\n").filter(Boolean).pop() || s;
  return last.length > 300 ? last.slice(0, 300) + "..." : last;
}

/**
 * Check 2: run every required port once, on a fixed probe, and require one
 * leaf per probe record. Returns the failures; the caller decides what to do
 * with them (both callers exit non-zero).
 */
export async function preflight(runners, { required = REQUIRED_PORTS, excluded = [], probe = DEFAULT_PROBE, label } = {}) {
  const want = required.filter((p) => !excluded.includes(p) && typeof runners[p] === "function");
  const expected = JSON.parse(probe).length;
  const failures = [];

  await Promise.all(
    want.map(async (name) => {
      let out;
      try {
        out = await runners[name](probe);
      } catch (e) {
        failures.push({ port: name, why: `preflight could not run it: ${errText(e)}` });
        return;
      }
      const lines = String(out).split("\n").filter(Boolean);
      if (lines.length !== expected) {
        failures.push({
          port: name,
          why: `preflight returned ${lines.length} leaf/leaves for ${expected} probe records` +
            (lines.length === 0 ? " -- the port loaded and printed nothing" : ""),
        });
        return;
      }
      const bad = lines.filter((l) => !LEAF_RE.test(l));
      if (bad.length) {
        failures.push({ port: name, why: `preflight returned ${bad.length} line(s) that are not a 64-hex leaf: ${JSON.stringify(bad[0].slice(0, 80))}` });
      }
    })
  );

  failures.sort((a, b) => want.indexOf(a.port) - want.indexOf(b.port));
  return { ok: failures.length === 0, failures, probed: want, probeRecords: expected };
}

export function fatalPreflight(p, label) {
  console.error(`\n${"=".repeat(72)}`);
  console.error(`FATAL: ${label} -- ${p.failures.length} participant(s) cannot produce a leaf.`);
  console.error("=".repeat(72));
  for (const f of p.failures) {
    console.error(`  ${f.port}: ${f.why}`);
    console.error(`      -> this port would otherwise be counted as ${p.probeRecords} missing leaves,`);
    console.error(`         which reads as a PORT DISAGREEMENT rather than a missing port.`);
  }
  console.error(`\nProbed [${p.probed.join(", ")}]. No corpus was touched.\n`);
  return 1;
}

/**
 * Check 3: accounting for a port that fails mid-run.
 *
 * A port is failed if it throws or returns the wrong number of leaves. Any
 * failure marks the whole batch invalid: rows from it are counted as neither
 * agreement nor disagreement, and the run exits non-zero. The point is that a
 * broken port can never be laundered into a smaller denominator.
 */
export class PortLedger {
  constructor() {
    this.failures = new Map();   // port -> first failure detail
    this.counts = new Map();     // port -> {batches, leaves}
    this.invalidBatches = 0;
  }

  record(port, n) {
    const c = this.counts.get(port) || { batches: 0, leaves: 0 };
    c.batches++; c.leaves += n;
    this.counts.set(port, c);
  }

  fail(port, why) {
    if (!this.failures.has(port)) this.failures.set(port, why);
  }

  get ok() { return this.failures.size === 0; }

  summary() {
    return [...this.failures.entries()].map(([port, why]) => ({ port, why }));
  }

  report(label) {
    const out = [];
    out.push(`${label}: participant failures: ${this.failures.size}`);
    for (const [port, why] of this.failures) {
      out.push(`  ${port}: ${why}`);
      out.push(`      -> batches run for this port before failing: ${this.counts.get(port)?.batches ?? 0}`);
    }
    if (this.invalidBatches) {
      out.push(`${label}: ${this.invalidBatches} batch(es) marked INVALID and excluded from the comparison.`);
      out.push(`      Their records are reported as records_not_compared, never as agreement.`);
    }
    return out.join("\n");
  }
}
