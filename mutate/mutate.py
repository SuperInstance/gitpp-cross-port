#!/usr/bin/env python3
"""Metamorphic mutation of the leaf corpus.

The corpus is generated from a seeded PRNG with a STRUCTURED distribution, so
it tests what its author thought to include. Every leaf bug found this week was
found by widening the corpus by hand, which means the corpus's coverage was
bounded by the same imagination that found the bugs.

Mutation removes the author from the loop. Take a record that all ports already
agree on, apply a TRANSFORMATION with a KNOWN effect on the leaf, and assert the
ports still agree afterwards. If they do not, the transformation found a case
nobody thought of.

The transformations are chosen to attack the specific ways a leaf can go wrong:
  float-mantissa-flip   a single ulp in the mantissa; the shortest round-trip
                         must change with it
  float-regime         2.0 -> 1.9999999999999998 (crosses into shortest-repr)
  key-collision         rename a key so two keys share a prefix and the
                         code-point sort must still order them
  unicode-normalise     NFC/NFD twins of the same visible string
  escape-injection      quotes, backslashes, control chars in a string value
  depth-bomb            nest an object 12 levels deep
  sibling-boundary      ids that differ only in the last code unit
  bool-number-adjacent  true / 1 in the same object
  lone-surrogate-pair   a 4-byte char next to a 3-byte one
"""
import json, random, struct, sys, unicodedata

random.seed(20261017)   # a DIFFERENT seed from the corpus, on purpose

def ulp_flip(x: float) -> float:
    """One ulp away. Changes the value, so the leaf MUST change."""
    b = struct.unpack('<Q', struct.pack('<d', x))[0]
    return struct.unpack('<d', struct.pack('<Q', b + 1))[0]

def regime_cross(x: float) -> float:
    """Cross a boundary where the shortest repr changes digit count."""
    return x * (1 + 2**-52)

def key_collision(eff: dict) -> dict:
    """Two keys that share a prefix, so ordering is decided past the prefix."""
    k = "sharedprefix"
    return {k + "A": 1, k + "B": 2, k + "AB": 3}

def unicode_normalise(eff: dict) -> dict:
    """NFC and NFD spellings of the same visible string are different bytes."""
    s = "é"                 # e + combining acute
    return {"nfc": unicodedata.normalize("NFC", s), "nfd": unicodedata.normalize("NFD", s)}

def escape_injection(eff: dict) -> dict:
    return {"q": 'he said "hi"', "bs": "back\\slash", "nl": "a\nb", "tab": "a\tb",
            "ctl": "a\x01b", "bsq": "a\\\"b"}

def depth_bomb(eff: dict) -> dict:
    v = 1
    for _ in range(12):
        v = {"n": v}
    return {"deep": v}

def sibling_boundary(eff: dict) -> dict:
    return {"a": "", "A": "x", "aa": 1, "aA": 2, "Aa": 3, "AA": 4}

def bool_number(eff: dict) -> dict:
    return {"t": True, "f": False, "one": 1, "zero": 0, "zerof": 0.0, "negzero": -0.0}

def wide_chars(eff: dict) -> dict:
    return {"emoji": "\U0001F680", "cjk": "折", "bmp": "Ω", "mixed": "a\U0001F680折"}

MUTATORS = {
    "float-mantissa-flip":  lambda eff, x: {"x": ulp_flip(x)},
    "float-regime":         lambda eff, x: {"x": regime_cross(x)},
    "key-collision":        lambda eff, x: key_collision(eff),
    "unicode-normalise":    lambda eff, x: unicode_normalise(eff),
    "escape-injection":     lambda eff, x: escape_injection(eff),
    "depth-bomb":           lambda eff, x: depth_bomb(eff),
    "sibling-boundary":     lambda eff, x: sibling_boundary(eff),
    "bool-number-adjacent": lambda eff, x: bool_number(eff),
    "wide-chars":           lambda eff, x: wide_chars(eff),
}

def main():
    src = json.load(open(sys.argv[1]))
    out, counts = [], {}
    for rec in src:
        eff = rec.get("effects", {})
        x = next((v for v in eff.values() if isinstance(v, float) and v not in (0.0,) and v == v),
                 None)
        if x is None:
            continue
        for name, fn in MUTATORS.items():
            if name.startswith("float-") and x is None:
                continue
            r = {"id": f"mut-{name}-{rec['id']}", "kind": rec.get("kind", "task"),
                 "parents": rec.get("parents", []), "effects": fn(eff, x), "reason": None}
            out.append(r)
            counts[name] = counts.get(name, 0) + 1
    json.dump(out, open(sys.argv[2], "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"  {len(src)} source records -> {len(out)} mutants")
    for k, v in sorted(counts.items()):
        print(f"    {k:<22} {v}")

main()
