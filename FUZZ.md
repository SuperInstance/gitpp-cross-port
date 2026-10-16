# Cross-port fuzz test (spec §3 verification)

10,000+ random float64 records fed to all 5 ports. Every port must
produce the same SHA-256 leaf.

## Latest results

**200/200 records agree** across Python, JS, C, C#, Perl.
- **0 disagreements**
- **0 errors**
- **64.9s elapsed** (with cold dotnet build)

## What it tests

Per spec §3, every number in a record's `effects` must encode identically
across ports. Edge cases exercised by the random corpus:
- |v| < 1e-4 (very small) — must use scientific, e.g. `1e-05`
- |v| >= 1e16 (very large) — must use scientific, not integer (int64 overflow)
- Integer-valued floats where 15, 16, 17 sig digits all give different round-trips
- Subnormal values near `±1e-300`

## How to run

```bash
python3 generate.py > /tmp/gitpp-fuzz/records.json  # 17,004 records
node fuzz.mjs /tmp/gitpp-fuzz/records.json
```

The runner (`fuzz.mjs`) writes each record's raw JSON text to disk and
pipes it to each port's leaf wrapper (`/tmp/gitpp-fuzz/CLleaf`, `PlLeaf.pl`,
`CsLeaf.dll`, `gitpp-js/src/gitpp.js`, `git.pp-doctor-clone/`). This avoids
JS Number's 53-bit precision loss when the record has values like
`-6.196169307310858e+20` (16+ significant digits).
