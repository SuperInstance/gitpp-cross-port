# wrappers

One leaf-wrapper per port. Each reads a JSON array of records on stdin and
prints one SHA-256 leaf per line.

| File | Port |
|------|------|
| `PlLeaf.pl` | [`gitpp-pl`](https://github.com/SuperInstance/gitpp-pl) |
| `CsLeaf/` | [`gitpp-cs`](https://github.com/SuperInstance/gitpp-cs) |
| `../CLleaf` | [`gitpp-c`](https://github.com/SuperInstance/gitpp-c) (self-contained C99) |

The Python and JS wrappers are inline in `fuzz.mjs` because they need a
one-line script around an import.

## Paths

`PlLeaf.pl` hardcodes `/tmp/gitpp-pl/lib` and `CsLeaf.csproj` defaults to
`/tmp/gitpp-cs/src/Gitpp.csproj`. Override the C# one with
`-p:GitppCsProj=/path/to/Gitpp.csproj`.
