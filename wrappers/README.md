# wrappers

One leaf-wrapper per port. Each reads a JSON array of records on stdin and
prints one SHA-256 leaf per line.

| File | Port | Needs |
|------|------|-------|
| `PlLeaf.pl` | [`gitpp-pl`](https://github.com/SuperInstance/gitpp-pl) | perl |
| `CsLeaf/` | [`gitpp-cs`](https://github.com/SuperInstance/gitpp-cs) | .NET 9 |
| `../CLleaf` | [`gitpp-c`](https://github.com/SuperInstance/gitpp-c) (self-contained C99) | gcc |
| `ElixirLeaf.exs` | [`gitpp-beam`](https://github.com/patchwork-quilt/gitpp-beam) | OTP 27 + Elixir 1.17 |

The Python and JS wrappers are inline in `fuzz.mjs` and
`mutate/run_mutants.mjs` because they need a one-line script around an import.

## Paths

Every wrapper resolves its port at RUN time from an environment variable, with
a single-machine `/tmp` path kept only as a fallback:

| Wrapper | Variable | Default |
|---------|----------|---------|
| `PlLeaf.pl` | `GITPP_PL_DIR` | `/tmp/gitpp-pl` |
| `CsLeaf.csproj` | `GITPP_CS_DIR` | sibling `../gitpp-cs` |
| `ElixirLeaf.exs` | `GITPP_EX_EBIN` | sibling `../gitpp-beam/_build/prod/lib/gitpp_beam/ebin` |

They were hardcoded once, which is how a port ends up silently absent from a
run that reports the same numbers as before. `fuzz.mjs` and `run_mutants.mjs`
now assert the roster and preflight every port, so a wrong path is a named
failure rather than a smaller denominator -- see `../participants.mjs`.

## The Elixir wrapper composes the leaf; it cannot call it

`gitpp-beam` has **no public leaf function**. `Gitpp.Fold.leaf/1` is `defp`.
The port's own `leaf_check.exs` re-derives it from public API only, and so does
`ElixirLeaf.exs`: `Fold.canonical_record/1` -> `Gitpp.Canon.encode!/1` ->
SHA-256.

A duplicated algorithm is a liability, so the wrapper proves the duplication
correct on every run. For a record whose closure is exactly `{id}` — which the
port's own closure walk guarantees for any record with an empty `parents` —
`Fold.checkpoint_root(records, id)` reduces to `sha256(id <> ":" <> leaf)`.
The wrapper compares its own leaf against that, and **exits non-zero rather
than printing leaves it cannot substantiate**. Run it standalone with:

```sh
elixir -pa "$GITPP_EX_EBIN" wrappers/ElixirLeaf.exs --selftest < records.json
```

`EX_LEAF_SELFTEST=all` checks every record of every batch (both corpora are
entirely parentless, so the check applies to 100% of them).

Records whose id repeats within a batch are **skipped**, not checked:
`checkpoint_root/2` indexes by id, so a batch holding the same id twice checks
the second record against the first one's root.

## Toolchain

`../scripts/install-beam.sh` installs OTP 27 and Elixir 1.17 from
builds.hex.pm, pinned by SHA-256, with no sudo.

The apt Elixir is **not** usable: it is 1.14, and `lib/gitpp/canon.ex` uses a
runtime-sized binary segment — `<<int_part::binary-size(^decpt), frac_part::binary>>`
— which is 1.17 syntax. Under 1.14 the port does not compile, and a wrapper
that cannot compile looks exactly like a port that disagrees.
