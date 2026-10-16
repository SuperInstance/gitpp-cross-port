// CLleaf - reads JSON record array from stdin, prints one leaf per line.
// Self-contained, no link to gitpp.c.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <ctype.h>
#include <math.h>

// SHA-256
static const uint32_t SHA256_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};
#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
static void sha256_transform(uint32_t state[8], const uint8_t block[64]) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)block[i*4] << 24) | ((uint32_t)block[i*4+1] << 16) | ((uint32_t)block[i*4+2] << 8) | (uint32_t)block[i*4+3];
    }
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROTR(w[i-15], 7) ^ ROTR(w[i-15], 18) ^ (w[i-15] >> 3);
        uint32_t s1 = ROTR(w[i-2], 17) ^ ROTR(w[i-2], 19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + S1 + ch + SHA256_K[i] + w[i];
        uint32_t S0 = ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22);
        uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + mj;
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}
static void sha256(const uint8_t *data, size_t len, uint8_t out[32]) {
    uint32_t state[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    uint8_t block[64];
    size_t i = 0;
    while (len - i >= 64) { sha256_transform(state, data + i); i += 64; }
    size_t remaining = len - i;
    memcpy(block, data + i, remaining);
    block[remaining] = 0x80;
    if (remaining >= 56) { memset(block + remaining + 1, 0, 64 - remaining - 1); sha256_transform(state, block); memset(block, 0, 56); }
    else { memset(block + remaining + 1, 0, 56 - remaining - 1); }
    uint64_t bits = (uint64_t)len * 8;
    for (int j = 0; j < 8; j++) block[56 + j] = bits >> (56 - j*8);
    sha256_transform(state, block);
    for (int j = 0; j < 8; j++) { out[j*4] = state[j] >> 24; out[j*4+1] = state[j] >> 16; out[j*4+2] = state[j] >> 8; out[j*4+3] = state[j]; }
}

// JSON types
typedef enum { JSON_NULL, JSON_BOOL, JSON_NUMBER, JSON_STRING, JSON_ARRAY, JSON_OBJECT } json_type_t;
typedef struct json_value json_value_t;
typedef struct json_member { char *key; json_value_t *value; } json_member_t;
struct json_value { json_type_t type; union { bool boolean; double number; char *string; struct { json_value_t **items; size_t count; } array; struct { json_member_t **members; size_t count; } object; } u; };

// JSON parser
static void skip_ws(const char **p) { while (**p && isspace((unsigned char)**p)) (*p)++; }
static json_value_t *json_parse_value(const char **p);

static json_value_t *parse_str(const char **p) {
    (*p)++; const char *start = *p;
    while (**p && **p != '"') { if (**p == '\\') (*p)++; (*p)++; }
    size_t len = *p - start; char *s = malloc(len + 1);
    size_t j = 0;
    for (size_t i = 0; i < len; i++) {
        if (start[i] == '\\' && i + 1 < len) {
            i++;
            switch (start[i]) {
                case 'n': s[j++] = '\n'; break; case 't': s[j++] = '\t'; break; case 'r': s[j++] = '\r'; break;
                case 'b': s[j++] = '\b'; break; case 'f': s[j++] = '\f'; break; case '\\': s[j++] = '\\'; break;
                case '"': s[j++] = '"'; break; case '/': s[j++] = '/'; break; case 'u': if (i + 4 < len) i += 4; break;
                default: s[j++] = start[i]; break;
            }
        } else { s[j++] = start[i]; }
    }
    s[j] = '\0';
    if (**p == '"') (*p)++;
    json_value_t *v = malloc(sizeof(json_value_t));
    v->type = JSON_STRING; v->u.string = s; return v;
}

static json_value_t *json_parse_value(const char **p) {
    skip_ws(p);
    if (**p == 'n' && strncmp(*p, "null", 4) == 0) {
        *p += 4; json_value_t *v = malloc(sizeof(json_value_t)); v->type = JSON_NULL; return v;
    }
    if (**p == 't' && strncmp(*p, "true", 4) == 0) {
        *p += 4; json_value_t *v = malloc(sizeof(json_value_t)); v->type = JSON_BOOL; v->u.boolean = true; return v;
    }
    if (**p == 'f' && strncmp(*p, "false", 5) == 0) {
        *p += 5; json_value_t *v = malloc(sizeof(json_value_t)); v->type = JSON_BOOL; v->u.boolean = false; return v;
    }
    if (**p == '-' || (**p >= '0' && **p <= '9')) {
        char *end; double n = strtod(*p, &end); *p = end;
        json_value_t *v = malloc(sizeof(json_value_t)); v->type = JSON_NUMBER; v->u.number = n; return v;
    }
    if (**p == '"') return parse_str(p);
    if (**p == '[') {
        (*p)++;
        json_value_t *v = malloc(sizeof(json_value_t));
        v->type = JSON_ARRAY; v->u.array.items = NULL; v->u.array.count = 0;
        skip_ws(p);
        if (**p != ']') {
            while (1) {
                v->u.array.items = realloc(v->u.array.items, sizeof(json_value_t*) * (v->u.array.count + 1));
                v->u.array.items[v->u.array.count++] = json_parse_value(p);
                skip_ws(p);
                if (**p == ',') { (*p)++; continue; }
                if (**p == ']') { (*p)++; break; }
                break;
            }
        } else { (*p)++; }
        return v;
    }
    if (**p == '{') {
        (*p)++;
        json_value_t *v = malloc(sizeof(json_value_t));
        v->type = JSON_OBJECT; v->u.object.members = NULL; v->u.object.count = 0;
        skip_ws(p);
        if (**p != '}') {
            while (1) {
                v->u.object.members = realloc(v->u.object.members, sizeof(json_member_t*) * (v->u.object.count + 1));
                json_member_t *m = malloc(sizeof(json_member_t));
                m->key = NULL; m->value = NULL;
                skip_ws(p);
                m->value = json_parse_value(p);
                if (m->value->type == JSON_STRING) m->key = m->value->u.string;
                skip_ws(p);
                if (**p == ':') (*p)++;
                m->value = json_parse_value(p);
                v->u.object.members[v->u.object.count++] = m;
                skip_ws(p);
                if (**p == ',') { (*p)++; continue; }
                if (**p == '}') { (*p)++; break; }
                break;
            }
        } else { (*p)++; }
        return v;
    }
    return NULL;
}

// Code point cmp (ASCII only for now)
static int code_point_cmp(const char *a, const char *b) {
    while (*a && *b) { if (*a != *b) return (unsigned char)*a - (unsigned char)*b; a++; b++; }
    return (unsigned char)*a - (unsigned char)*b;
}

// Emit number
// Try 15/16/17 sig digits (Python repr short algorithm). Integer form
// requires |v| < 1e16 to fit in int64 across all 5 ports.
static void emit_number(FILE *out, double v) {
    if (v == 0) { fprintf(out, "0"); return; }
    if (v == floor(v) && fabs(v) < 1e16) { fprintf(out, "%lld", (long long)v); return; }
    double abs_v = fabs(v);
    char buf[64];
    int digits;
    int found = 0;
    for (digits = 15; digits <= 17; digits++) {
        snprintf(buf, sizeof(buf), "%.*g", digits, v);
        double back = strtod(buf, NULL);
        if (back == v) {
            // If this is integer form and |v| >= 1e16, keep looking
            if (abs_v >= 1e16 && strchr(buf, 'e') == NULL) continue;
            found = 1;
            break;
        }
    }
    if (!found) {
        // All 15/16/17 attempts failed or were integer (rejected because
        // |v| >= 1e16). Use 16 digits scientific with trailing zero strip
        // (matches Python repr()).
        snprintf(buf, sizeof(buf), "%.16e", v);
        char *ep = strchr(buf, 'e');
        if (ep) {
            char *p = ep - 1;
            while (p > buf && *p == '0') p--;
            if (*p == '.') p--;
            memmove(p + 1, ep, strlen(ep) + 1);
        }
    }
    if (abs_v < 1e-4 || abs_v >= 1e16) {
        char *e = strchr(buf, 'e'); if (e) { *e = 0; e++; int exp = atoi(e); fprintf(out, "%se%c%02d", buf, exp < 0 ? '-' : '+', abs(exp)); }
        else fprintf(out, "%s", buf);
    } else {
        fprintf(out, "%s", buf);
    }
}

static void emit_string(FILE *out, const char *s) {
    fputc('"', out);
    while (*s) {
        unsigned char c = (unsigned char)*s;
        switch (c) { case '"': fputs("\\\"", out); break; case '\\': fputs("\\\\", out); break; case '\n': fputs("\\n", out); break; case '\r': fputs("\\r", out); break; case '\t': fputs("\\t", out); break; case '\b': fputs("\\b", out); break; case '\f': fputs("\\f", out); break; default: if (c < 0x20) fprintf(out, "\\u%04x", c); else fputc(c, out); }
        s++;
    }
    fputc('"', out);
}

static int member_cmp(const void *a, const void *b) {
    const json_member_t *ma = *(const json_member_t **)a;
    const json_member_t *mb = *(const json_member_t **)b;
    return strcmp(ma->key, mb->key);
}

static void emit_value(FILE *out, json_value_t *v) {
    if (!v) { fputs("null", out); return; }
    switch (v->type) {
        case JSON_NULL: fputs("null", out); break;
        case JSON_BOOL: fputs(v->u.boolean ? "true" : "false", out); break;
        case JSON_NUMBER: emit_number(out, v->u.number); break;
        case JSON_STRING: emit_string(out, v->u.string); break;
        case JSON_ARRAY:
            fputc('[', out);
            for (size_t i = 0; i < v->u.array.count; i++) { if (i > 0) fputs(", ", out); emit_value(out, v->u.array.items[i]); }
            fputc(']', out);
            break;
        case JSON_OBJECT: {
            size_t n = v->u.object.count;
            json_member_t **sorted = malloc(sizeof(json_member_t*) * n);
            for (size_t i = 0; i < n; i++) sorted[i] = v->u.object.members[i];
            qsort(sorted, n, sizeof(json_member_t*), member_cmp);
            fputc('{', out);
            for (size_t i = 0; i < n; i++) { if (i > 0) fputs(", ", out); emit_string(out, sorted[i]->key); fputs(": ", out); emit_value(out, sorted[i]->value); }
            fputc('}', out);
            free(sorted);
            break;
        }
    }
}

static int parent_cmp(const void *a, const void *b) {
    return code_point_cmp(*(const char**)a, *(const char**)b);
}

static json_value_t *obj_get(json_value_t *obj, const char *key) {
    if (obj->type != JSON_OBJECT) return NULL;
    for (size_t i = 0; i < obj->u.object.count; i++) if (strcmp(obj->u.object.members[i]->key, key) == 0) return obj->u.object.members[i]->value;
    return NULL;
}
static const char *obj_get_str(json_value_t *obj, const char *key) {
    json_value_t *v = obj_get(obj, key);
    return (v && v->type == JSON_STRING) ? v->u.string : NULL;
}

static void record_leaf(json_value_t *obj, char out_hex[65]) {
    const char *id = obj_get_str(obj, "id");
    const char *kind = obj_get_str(obj, "kind");
    if (!kind) kind = "task";
    const char *reason = obj_get_str(obj, "reason");
    json_value_t *effects = obj_get(obj, "effects");
    if (!effects) {
        static json_value_t empty = {.type = JSON_OBJECT, .u.object = {0, NULL}};
        effects = &empty;
    }
    
    json_value_t *parents = obj_get(obj, "parents");
    char **sorted_parents = NULL;
    size_t parent_count = 0;
    if (parents && parents->type == JSON_ARRAY) {
        parent_count = parents->u.array.count;
        sorted_parents = malloc(sizeof(char*) * parent_count);
        for (size_t i = 0; i < parent_count; i++) {
            json_value_t *p = parents->u.array.items[i];
            sorted_parents[i] = (p->type == JSON_STRING) ? p->u.string : "";
        }
        qsort(sorted_parents, parent_count, sizeof(char*), parent_cmp);
    }
    
    char buf[65536];
    FILE *mem = fmemopen(buf, sizeof(buf), "w");
    fputc('{', mem);
    fputs("\"effects\": ", mem);
    emit_value(mem, effects);
    fputs(", \"id\": ", mem);
    fputc('"', mem);
    if (id) for (const char *p = id; *p; p++) fputc(*p, mem);
    fputc('"', mem);
    fputs(", \"kind\": ", mem);
    fputc('"', mem);
    if (kind) for (const char *p = kind; *p; p++) fputc(*p, mem);
    fputc('"', mem);
    fputs(", \"parents\": [", mem);
    for (size_t i = 0; i < parent_count; i++) {
        if (i > 0) fputs(", ", mem);
        fputc('"', mem);
        for (const char *p = sorted_parents[i]; *p; p++) fputc(*p, mem);
        fputc('"', mem);
    }
    fputc(']', mem);
    fputs(", \"reason\": ", mem);
    if (reason) {
        fputc('"', mem);
        for (const char *p = reason; *p; p++) fputc(*p, mem);
        fputc('"', mem);
    } else {
        fputs("null", mem);
    }
    fputc('}', mem);
    fclose(mem);
    size_t pos = strlen(buf);
    unsigned char hash[32];
    sha256((unsigned char *)buf, pos, hash);
    for (int i = 0; i < 32; i++) sprintf(out_hex + i*2, "%02x", hash[i]);
    out_hex[64] = '\0';
    
    if (sorted_parents) free(sorted_parents);
}

int main() {
    char *data = NULL;
    size_t cap = 1024*1024*16;
    data = malloc(cap);
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
        record_leaf(arr->u.array.items[i], hex);
        printf("%s\n", hex);
    }
    return 0;
}
