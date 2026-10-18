// CLleaf - reads a JSON record array from stdin, prints one leaf per line.
//
// THIS FILE NO LONGER CARRIES A COPY OF THE C PORT.
//
// It used to. The header said "Self-contained, no link to gitpp.c", and
// that was true: 345 lines of SHA-256, JSON parser and canonicaliser,
// forked from gitpp-c at some point in the past and never updated
// again.
//
// That was a mutation pass testing a SNAPSHOT.
//
// The consequence is worse than a stale test fixture. The mutation
// corpus exists to be independent of the corpus author's imagination,
// and a frozen copy satisfies neither: it is not the port, and it is
// not fresh either. The escape-injection class reported 14,611
// disagreements -- which was the COPY being stale, not the port being
// wrong -- and meanwhile the real port's leaf was never exercised at
// all, so a bug in it would have been invisible.
//
// So the wrapper now INCLUDES the port, using the pattern the port's
// own test suite already uses:
//
//     #define main gitpp_main_never_called
//     #include "../gitpp-c/gitpp.c"
//     #undef main
//
// and then drives the port's OWN parse_record/1 and record_leaf/2.
// Every fix to the port -- the escape decoding, the fixed-size
// buffers, the kind handling -- now arrives here automatically, and a
// fix to the PORT cannot be missed by a copy of it.
//
// The path is resolved at BUILD time and can be overridden with
// -DGITPP_C_SRC=..., because "the sibling repository" is an assumption
// like any other.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef GITPP_C_SRC
#define GITPP_C_SRC "../gitpp-c/gitpp.c"
#endif

// The port's main is renamed out of the way; everything else -- the
// JSON parser, the canonicaliser, record_leaf/2 -- comes from the port.
#define main gitpp_main_never_called
#include GITPP_C_SRC
#undef main

int main(void) {
    size_t cap = 1024 * 1024 * 16;
    char *data = malloc(cap);
    if (!data) { fprintf(stderr, "out of memory\n"); return 1; }
    size_t len = 0;
    while (1) {
        size_t n = fread(data + len, 1, cap - len - 1, stdin);
        if (n == 0) break;
        len += n;
        if (len >= cap - 1) break;
    }
    data[len] = '\0';

    const char *p = data;
    json_value_t *arr = json_parse_value(&p);
    if (!arr || arr->type != JSON_ARRAY) { fprintf(stderr, "expected array\n"); return 1; }

    for (size_t i = 0; i < arr->u.array.count; i++) {
        char hex[65];
        // The PORT's parse, not a copy of it.
        record_t r = parse_record(arr->u.array.items[i]);
        record_leaf(&r, hex);
        printf("%s\n", hex);
    }
    return 0;
}
