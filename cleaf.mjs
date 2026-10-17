// Leaf wrapper for the C99 port (CLleaf reads stdin, prints one leaf per line).
//
// The payload must travel on STDIN, not argv. A single argv entry is capped
// at MAX_ARG_STRLEN = 128 KiB (32 pages) on Linux, independently of the much
// larger ARG_MAX. Measured:
//
//   arg 125 KB  rc=0
//   arg 128 KB  rc=null  E2BIG
//
// A batch of 2000 records is ~206 KB and killed this port, while the harness
// reported it as a crash rather than an argument error. Every other wrapper
// (py, js) writes a temp file and (cs, pl) uses stdin; this one alone passed
// the whole batch as a single command-line argument.
//
// CLleaf was always written to read stdin, so this is the interface it expects.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "CLleaf");
// Accept either an argument (legacy, small batches) or a file path prefixed
// with '@', so callers that already spool to disk pay nothing.
const arg = process.argv[2];
const payload = arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8") : arg;

const r = spawnSync(bin, [], {
  input: payload,
  encoding: "utf8",
  maxBuffer: 1 << 26,
  env: process.env,
});
if (r.error) { console.error(`cleaf: ${r.error.code || r.error.message}`); process.exit(1); }
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(r.status || 1); }
fs.writeFileSync(process.argv[3], r.stdout);
