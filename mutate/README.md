# mutate — metamorphic mutation of the leaf corpus

The corpus is generated from a seeded PRNG with a **structured**
distribution, so it tests what its author thought to include. Every leaf
bug found this week was found by widening the corpus by hand — which
means the corpus's coverage was bounded by the same imagination that
found the bugs.

Mutation removes the author from the loop. Take a record the ports all
agree on, apply a transformation with a **known effect on the leaf**, and
assert the ports still agree. If they don't, the transformation found a
case nobody thought of.

## Transformations

Each attacks a specific way a leaf can go wrong:

| name | what it does |
|---|---|
| `float-mantissa-flip` | one ulp in the mantissa; the shortest round-trip must change with it |
| `float-regime` | cross a boundary where the shortest repr changes digit count |
| `key-collision` | rename a key so two keys share a prefix and the code-point sort must still order them |
| `unicode-normalise` | NFC/NFD twins of the same visible string |
| `escape-injection` | quotes, backslashes, control chars in a string value |
| `depth-bomb` | nest an object 12 levels deep |
| `sibling-boundary` | ids that differ only in the last code unit |
| `bool-number-adjacent` | `true` and `1` in the same object |
| `wide-chars` | a 4-byte char next to a 3-byte one |

## What it found

On its first run, on a port that had passed **20,043 / 20,043** records:

`gitpp-c`'s `parse_str` **drops `\uXXXX` escapes entirely**, so
`{"c":"a\u0001b"}` and `{"c":"ab"}` get the *same* leaf. That is a
hash collision, not a formatting difference — silent data loss in the
reference-conformant C port. Reported as [gitpp-c#1](https://github.com/SuperInstance/gitpp-c/issues/1).

The other four ports distinguish the two correctly.

## Why 20,043 records never caught it

The float64 corpus only ever puts **numbers** in `effects`. The only
`\u` anywhere in the project is in spec §3.5 case-4, and that is an
**id** field passed as literal UTF-8 bytes (a real 🚀), not as a
`\uXXXX` escape. The escape-decoding path in a string **value** was
never executed by a single corpus record.

## The lesson

**A corpus only covers what its author imagined.** 20,043 records of
random numbers contain no escape-encoded string value because the
generator never thought to put one there. Widening the corpus found
four real bugs in a week; mutating it found a fifth in an hour.
