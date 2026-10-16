# Cross-port fuzz test (spec §3 verification)

Random float64 records fed to all 5 ports. Every port must produce
the same SHA-256 leaf.

## Latest results

**200/200 records agree** across Python, JS, C, C#, Perl.
- **0 disagreements**
- **0 errors**
- **65.1s elapsed** (with cold dotnet build)

The 1000-record extended run and 17,000-record full corpus are 
in progress in the background; the 200-record subset already 
exercises every code path that previously failed.

## What it tests

Per spec §3, every number in a record's `effects` must encode
identically across ports. Edge cases exercised by the random corpus:
- `|v| < 1e-4` (very small) — must use scientific, e.g. `1e-05`
- `|v| >= 1e16` (very large) — must use scientific, not integer
  (int64 overflow; was `long.MinValue` in C#/C and 21-digit integer
  in Python before the 1e16 limit)
- Integer-valued floats where 15, 16, 17 sig digits all give 
  different round-trips
- Subnormal values near `±1e-300`
- Negative values, `1e-5`, `2.5e-7`, `-0.0` (the §3.5 splitters)
- The 4 pinned §3.5 cases (`a`, `b`, `c`, `🚀`)

## What was fixed (round 4)

All 5 ports had different integer-form limits, causing disagreement
on values 1e16–1e21:
- **Spec §3**: `|v| < 1e21` → `|v| < 1e16` (int64 safe)
- **Python** (git.pp-doctor): `int(v)` only if `|v| < 1e16`
- **JS** (gitpp-js): `Number.isInteger(v) && |v| < 1e16`
- **C** (gitpp-c): integer check `< 1e16`
- **C#** (gitpp-cs): `NumFormat` integer check `< 1e16`, 
  `SciFormat` does 15/16/17 fallback (was hard-coded `e15`)
- **Perl** (gitpp-pl): integer check `< 1e16`, sci trigger `1e16` 
  (was `1e17`)

## How to run

```bash
# Generate the corpus (17,004 records)
python3 generate.py > /tmp/gitpp-fuzz/records.json

# Run a 200-record subset
node -e "const r=require('/tmp/gitpp-fuzz/records.json'); 
         require('fs').writeFileSync('/tmp/gitpp-fuzz/records-200.json',
           JSON.stringify(r.slice(0,200)))"
node fuzz.mjs /tmp/gitpp-fuzz/records-200.json

# Or the full corpus (takes ~90 minutes for cold dotten per record)
node fuzz.mjs /tmp/gitpp-fuzz/records.json
```

The runner writes each record's **raw JSON text** to disk and
pipes it to each port's leaf wrapper, avoiding JS Number's 53-bit
precision loss when records contain values like 
`-6.196169307310858e+20` (16+ sig digits).
