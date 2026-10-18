# gitpp-cross-port

> The byte-level cross-port equivalence test. Runs the same 30 cases through 5 ports and proves they produce identical closure roots. The "byte-equivalence" of a fold is the strongest possible conformance — the ports are interchangeable.

## What this is

This is a permanent artifact of the [git.pp fold ports](../git.pp-spec) ecosystem. The five ports are:

| Port | Lang | Stdlib only | Source |
|------|------|-------------|--------|
| **C** (7th) | C99 | yes | [SuperInstance/gitpp-c](https://github.com/SuperInstance/gitpp-c) |
| **Python** (referee) | Python 3 | yes | [git.pp-ng/referee/](https://github.com/patchwork-quilt/git.pp-ng/tree/main/referee) |
| **JavaScript** (4th) | JS (ESM) | yes | [SuperInstance/gitpp-js](https://github.com/SuperInstance/gitpp-js) |
| **C#** (5th) | C# / .NET 9 | yes | [SuperInstance/gitpp-cs](https://github.com/SuperInstance/gitpp-cs) |
| **Perl** (6th) | Perl 5.36 | yes | [SuperInstance/gitpp-pl](https://github.com/SuperInstance/gitpp-pl) |

All 5 ports are written from the spec v0.3.0 alone (doc-only discipline: zero reads of the other ports). They diverge only in the implementation language; the byte output of the fold is identical.

## How to run

```bash
node run.mjs
```

Requires: Node 22+, Python 3, .NET 9, Perl 5.36. The runner spawns each port's CLI as a subprocess and compares the closure roots.

## Receipt: 30/30 closure roots byte-for-byte equivalent

```
$ node run.mjs
Running 30 cases across 5 ports (c, python, javascript, csharp, perl)...

Agreement: 30 all-agree, 0 disagree, 0 some-error
```

The 30 cases are:
- **28 conformance cases** from [SuperInstance/gitpp-conformance](https://github.com/SuperInstance/gitpp-conformance) — the public corpus.
- **2 live cases** (the full 8-record `poc-quilt-1` set folded at `task-c` and `task-d`).

Plus **4 pinned cross-port leaf verification cases** from `git.pp-spec/cross-port-leafs.json` — every port produces the exact byte-for-byte hash.

## The pinned closure root (the number to remember)

```
60effe23970d8a5cc837636c44685502361288c1f00577e9addfa10cbd4fc91d
```

This is the closure root at `poc-quilt-1@task-c`, computed from the live 8-record set in `https://gitpp.superinstance.dev`. All 5 ports produce this exact hash. The hub (TypeScript) and the Elixir port also produce it, but those aren't in this repo.

## Bugs found and fixed

This cross-port test has caught (and the maintainers have fixed) several real bugs in the various ports:

### v0.1.0 of the Perl port had 5 bugs

1. **JSON::PP booleans** are `JSON::PP::Boolean` objects, not `true`/`false` strings. `EmitValue` was falling through to "ref" and emitting `null`. Fix: `if (ref($v) eq 'JSON::PP::Boolean') { return $v ? "true" : "false"; }`.
2. **`$$path[$idx]`** doesn't compile in Perl 5.36. Use `$path->[$idx]`.
3. **Wide character in sha256** with `use utf8`. Need `Encode::encode_utf8` before hashing.
4. **ARGV is bytes by default**. For non-ASCII record ids, need `decode_utf8` on ARGV.
5. **JSON::PP `canonical(1)` is too compact** (no spaces). Custom 30-line encoder.

### v0.1.0 of the JS port had 1 bug

6. **`v.toString()` for floats** gives JavaScript's default (e.g. `0.00001` for `1e-5`). The spec says scientific with 2-digit zero-padded exponent (`1e-05`). Fix: custom `numFormat()` matching Python's repr.

### v0.2.0 of the C# port had 2 bugs

7. **`GetRawText()` for JsonValueKind.Number** returns the literal input bytes (`1e-5`), not the canonical form. Fix: `TryGetInt64 / NumFormat(je.GetDouble())`.
8. **Integers formatted as `1.0`** via `ToString("F1")`. Spec says integer digits. Fix: `(long)v.ToString()` for integer-valued floats.

### gitpp-c (7th port) had 1 bug

9. **Heap-use-after-free in closure_root.** The `closure_set` array was freed before being read in the output loop. C is the only language where this would crash — Python/JS/Perl have GC. Fix: copy the strings before freeing the array.

### All ports: integer vs float distinction

The spec implicitly requires: integer literals in JSON should encode as `1` (no decimal). JavaScript doesn't distinguish int from float, so `JSON.parse("1")` gives the number `1` (a float). `String(1)` gives `"1"`, which is what Python's `repr(1)` gives. The JS port now uses `String(v)` for `Number.isInteger(v)`, matching Python's behavior.

## Why byte-for-byte equivalence matters

If two ports produce different bytes for the same input, one of them is wrong. There is no "implementation-defined" escape hatch in the spec — the leaf is the leaf, the root is the root. This is the strongest possible conformance test for a fold.

For a fold, this matters because:
- **A receipt is a hash.** If the same record set can be folded to different closure roots depending on the language you ask, the receipt is not portable.
- **Cross-organisation verification.** A witness from a Python tool can be checked by a JS tool. A C# build can be signed by a Perl auditor. Same bytes in, same bytes out.
- **Specification validation.** If 5 ports written from prose alone agree byte-for-byte, the spec is normative — not just a tutorial.

## What's NOT tested

- **Performance.** This is a byte-equivalence test, not a benchmark. For benchmarks, see [SuperInstance/gitpp-bench](https://github.com/SuperInstance/gitpp-bench).
- **The TypeScript hub or the Elixir port.** Those are tested by their own test suites. Adding them here would require either running them on the conformance cases (the hub doesn't have a programmatic `/derive` endpoint that takes arbitrary record sets) or pulling them into a different harness.
- **The Rust port.** Scaffolded at [SuperInstance/gitpp-rust](https://github.com/SuperInstance/gitpp-rust) but not implemented (no cargo in the writing sandbox).

## Pass criterion

**30/30 closure roots byte-for-byte equivalent across all 5 ports.** Plus 4/4 pinned cross-port leaves match. No exceptions. If a port produces a different byte, that's a bug — in the port, not in this test.

## License

Same as the rest of the quilt family: copyright SuperInstance, MIT.
