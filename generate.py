#!/usr/bin/env python3
"""Generate a fuzz test for the git.pp cross-port byte-equivalence.

Per spec §3.5: 10,000 random float64 values + 4 targeted splitters 
must produce identical bytes across ports.

We extend this with multi-key, nested-object, and numeric-string cases
for higher coverage:
- 10,000 single-effect records with random float64 values
- 4 targeted splitters (1e-5, 2.5e-7, -0.0, 724818294626474393600)
- 5,000 multi-effect records (2-5 effects per record)
- 1,000 nested-object records
- 1,000 array-effect records
- 2,000 records pairing a real number with a numeric-string twin
- 1,000 records whose only effect is a numeric string

Total: 20,004 records per fuzz batch.
"""
import json
import struct
import random
import sys

random.seed(42)  # reproducible

def random_float64():
    """Generate a random float64 in the pinned domain |v| < 1e21."""
    # Pick a random exponent and mantissa
    exp = random.randint(-300, 21)
    if exp >= 0:
        mag = 10 ** exp
    else:
        mag = 1.0 / (10 ** (-exp))
    # Mantissa: random sign, random digits
    sign = random.choice([1, -1])
    mantissa = random.uniform(0.1, 1.0)
    return sign * mag * mantissa

def random_string():
    return ''.join(random.choice('abcdefghijklmnop') for _ in range(random.randint(3, 12)))

def numeric_string():
    """A STRING whose content is a valid number literal.

    gitpp-pl v0.1.5 shipped a leaf defect here: JSON::PP returns a bare
    scalar for both a JSON number and a JSON string, and the port used
    looks_like_number() to decide which -- true for both -- so the string
    was emitted unquoted and hashed as a number. The 17,004-record corpus
    never found it because every effect was a real number.

    These records exist to keep that path under test forever.
    """
    v = random_float64()
    forms = [
        repr(v),                 # 1.5e+20
        f"{v}",                  # 150000000000000000000
        f"{v:.6g}",
        f"{v:.15g}",
        f"{v:.17g}",
        str(int(v)) if abs(v) < 1e15 else f"{v:.0f}",
        "-0.0", "0", "1", "1e-5", "1e400" if random.random() < 0.1 else "1e5",
        " 42", "42 ", "+7", "0x1f", "Infinity", "NaN", "1_000",
    ]
    return random.choice(forms)

def make_single_effect_record(effects, id_prefix='rec'):
    return {
        "id": f"{id_prefix}-{random.randint(0, 10**9)}",
        "kind": "task",
        "parents": [],
        "effects": effects,
        "reason": None,
    }

def make_multi_effect_record(n_effects):
    effects = {}
    for _ in range(n_effects):
        key = random_string()
        # Mix of types
        t = random.choice(['float', 'string', 'bool', 'int', 'nested'])
        if t == 'float':
            effects[key] = random_float64()
        elif t == 'string':
            effects[key] = random_string()
        elif t == 'bool':
            effects[key] = random.choice([True, False])
        elif t == 'int':
            effects[key] = random.randint(-1000, 1000)
        elif t == 'nested':
            effects[key] = {
                random_string(): random_float64(),
                random_string(): random_string(),
            }
    return make_single_effect_record(effects)

def make_numstr_pair_record():
    """One key set twice in the same record is impossible in JSON, so use two
    keys: the real number and its string twin. A port that cannot tell them
    apart produces identical leaves for keys that should differ."""
    v = random_float64()
    return {
        "n": v,
        "s": numeric_string(),
    }

def make_nested_record():
    effects = {
        "a": {
            "b": random_float64(),
            "c": [random_float64() for _ in range(random.randint(2, 8))],
        },
        "d": random_string(),
        "e": random.choice([True, False, None]),
    }
    return make_single_effect_record(effects)

def make_array_record():
    effects = {
        "values": [random_float64() for _ in range(random.randint(2, 8))],
        "labels": [random_string() for _ in range(random.randint(2, 5))],
    }
    return make_single_effect_record(effects)

records = []

# 1. 10,000 single-effect random float64
for _ in range(10000):
    records.append(make_single_effect_record({"x": random_float64()}))

# 2. 4 targeted splitters
for v in [1e-5, 2.5e-7, -0.0, 724818294626474393600]:
    records.append(make_single_effect_record({"x": v}, id_prefix="splitter"))

# 3. 5,000 multi-effect records
for _ in range(5000):
    records.append(make_multi_effect_record(random.randint(2, 5)))

# 4. 1,000 nested records
for _ in range(1000):
    records.append(make_nested_record())

# 5. 1,000 array records
for _ in range(1000):
    records.append(make_array_record())

# 6. 2,000 records mixing a real number with a numeric STRING twin.
#    Added after gitpp-pl v0.1.5: the number/string confusion lived in a
#    path none of the classes above ever reached.
for _ in range(2000):
    records.append(make_single_effect_record(make_numstr_pair_record()))

# 7. 1,000 single-key records whose only effect is a numeric string
for _ in range(1000):
    records.append(make_single_effect_record({"x": numeric_string()}))

# Write
out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/gitpp-fuzz/records.json'
with open(out, 'w') as f:
    json.dump(records, f, ensure_ascii=False, separators=(',', ':'))

print(f"Generated {len(records)} records to {out}", file=sys.stderr)
