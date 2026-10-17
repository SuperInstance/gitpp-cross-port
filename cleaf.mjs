// Leaf wrapper for the C99 port (CLleaf reads stdin, prints one leaf per line).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const r = spawnSync(path.join(path.dirname(new URL(import.meta.url).pathname), "CLleaf"), [],
  { input: process.argv[2], encoding: "utf8", maxBuffer: 1 << 26, env: process.env });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(r.status || 1); }
fs.writeFileSync(process.argv[3], r.stdout);
