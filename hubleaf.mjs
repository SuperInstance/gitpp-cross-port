#!/usr/bin/env node
// Leaf wrapper for the TypeScript hub.
//
// The hub is the REFERENCE implementation, which is exactly why it needed
// measuring: "all five ports agree" was a claim about five ports and said
// nothing about the reference they were all ported from. It does not.
//
// Requires the hub compiled to ESM first (tsc -> OUT_DIR), since the oracle
// must not assume a build system it does not control.
import fs from "node:fs";

// Resolved at RUN time, with a RELATIVE fallback. The absolute path
// /tmp/hub-build/fold.js exists on exactly one machine, and on that
// machine it holds whatever was last built there -- not necessarily
// the build under test. The hub is a SIBLING of this repository.
const modPath = process.env.HUB_BUILD
  || new URL("../hub/fold.js", import.meta.url).pathname;
const { recordLeaf } = await import(modPath);

const recs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = [];
for (const r of recs) {
  try { out.push(recordLeaf(r)); } catch (e) { out.push("ERR:" + String(e.message).slice(0, 80)); }
}
fs.writeFileSync(process.argv[3], out.join("\n") + "\n");
