#!/usr/bin/env python3
"""Generate a fuzz test for the git.pp cross-port byte-equivalence.

Per spec §3.5: 10,000 random float64 values + 4 targeted splitters 
must produce identical bytes across ports.

We extend this with multi-key and nested-object cases for higher 
coverage:
- 10,000 single-effect records with random float64 values
- 4 targeted splitters (1e-5, 2.5e-7, -0.0, 724818294626474393600)
- 5,000 multi-effect records (2-5 effects per record)
- 1,000 nested-object records
- 1,000 array-effect records

Total: 17,004 records per fuzz batch.
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

# Write
out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/gitpp-fuzz/records.json'
with open(out, 'w') as f:
    json.dump(records, f, ensure_ascii=False, separators=(',', ':'))

print(f"Generated {len(records)} records to {out}", file=sys.stderr)
