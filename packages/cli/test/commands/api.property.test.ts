/**
 * Property-Based Tests for API Command Parsing Functions
 *
 * Uses fast-check to verify invariants of pure parsing functions
 * that are difficult to exhaustively test with example-based tests.
 */

import {
  array,
  asyncProperty,
  constantFrom,
  dictionary,
  assert as fcAssert,
  jsonValue,
  oneof,
  property,
  record,
  string,
  stringMatching,
  tuple,
  uniqueArray,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  buildFromFields,
  extractJsonBody,
  normalizeEndpoint,
  normalizeFields,
  parseDataBody,
  parseFieldKey,
  parseFieldValue,
  parseMethod,
  resolveBody,
  resolveEffectiveHeaders,
  resolveRequestUrl,
  setNestedValue,
} from "../../src/commands/api.js";
import { ValidationError } from "../../src/lib/errors.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Arbitraries for generating valid inputs

/** Valid HTTP methods (any case) */
const validMethodArb = constantFrom(
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "Get",
  "pOsT"
);

/** Invalid HTTP methods */
const invalidMethodArb = constantFrom(
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
  "INVALID",
  "",
  "GETS",
  "POSTING"
);

/** Path segments (alphanumeric with hyphens, no slashes) */
const pathSegmentArb = stringMatching(/^[a-z0-9][a-z0-9-]{0,20}[a-z0-9]$/);

/** Simple endpoint paths without query strings */
const simplePathArb = array(pathSegmentArb, { minLength: 1, maxLength: 5 }).map(
  (segments) => segments.join("/")
);

/** Query string (starts with ?, contains valid chars) */
const queryStringArb = stringMatching(/^\?[a-zA-Z0-9_=&%-]{1,50}$/).map((q) =>
  q.length > 1 ? q : "?q=1"
);

/** Endpoint with optional query string */
const endpointArb = tuple(
  simplePathArb,
  oneof(constantFrom(""), queryStringArb)
).map(([path, query]) => path + query);

/** Valid field key base (alphanumeric with underscores) */
const fieldKeyBaseArb = stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/);

/** Bracket segment (alphanumeric key or empty for array push) */
const bracketSegmentArb = oneof(
  fieldKeyBaseArb.map((k) => `[${k}]`),
  constantFrom("[]") // array push
);

/** Valid nested field key like "user[name]" or "tags[]" */
const nestedFieldKeyArb = tuple(
  fieldKeyBaseArb,
  array(bracketSegmentArb, { minLength: 0, maxLength: 3 })
).map(([base, brackets]) => {
  // Ensure empty brackets only at end
  const emptyIdx = brackets.indexOf("[]");
  if (emptyIdx !== -1 && emptyIdx < brackets.length - 1) {
    // Move empty bracket to end
    const filtered = brackets.filter((b) => b !== "[]");
    return `${base}${filtered.join("")}[]`;
  }
  return `${base}${brackets.join("")}`;
});

/** JSON-parseable values */
const jsonValueArb = oneof(
  constantFrom(
    "true",
    "false",
    "null",
    "123",
    "3.14",
    '"hello"',
    "[1,2,3]",
    '{"a":1}'
  )
);

/**
 * Non-JSON string values that won't be parsed as JSON.
 * Excludes: "true", "false", "null", pure numbers, and anything starting with JSON delimiters.
 * Uses a prefix that ensures the string can't be valid JSON.
 */
const plainStringArb = stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{0,20}$/).filter(
  (s) =>
    s !== "true" &&
    s !== "false" &&
    s !== "null" &&
    !/^\d+(\.\d+)?$/.test(s) &&
    !s.startsWith('"') &&
    !s.startsWith("[") &&
    !s.startsWith("{")
);

describe("normalizeEndpoint properties", () => {
  test("result never has leading slash (except for root)", async () => {
    await fcAssert(
      property(endpointArb, (endpoint) => {
        const result = normalizeEndpoint(endpoint);
        // Root "/" is the only case where leading slash is allowed
        if (result !== "/") {
          expect(result.startsWith("/")).toBe(false);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result always has trailing slash before query string", async () => {
    await fcAssert(
      property(endpointArb, (endpoint) => {
        const result = normalizeEndpoint(endpoint);
        const queryIdx = result.indexOf("?");

        if (queryIdx === -1) {
          // No query string - must end with /
          expect(result.endsWith("/")).toBe(true);
        } else {
          // Has query string - char before ? must be /
          expect(result[queryIdx - 1]).toBe("/");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("query string is always preserved unchanged", async () => {
    await fcAssert(
      property(tuple(simplePathArb, queryStringArb), ([path, query]) => {
        const input = path + query;
        const result = normalizeEndpoint(input);

        // Query string should be preserved exactly
        expect(result.endsWith(query)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent: normalizing twice equals normalizing once", async () => {
    await fcAssert(
      property(endpointArb, (endpoint) => {
        const once = normalizeEndpoint(endpoint);
        const twice = normalizeEndpoint(once);
        expect(twice).toBe(once);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("leading slash is always stripped", async () => {
    await fcAssert(
      property(simplePathArb, (path) => {
        const withLeading = `/${path}`;
        const withoutLeading = path;

        const resultWith = normalizeEndpoint(withLeading);
        const resultWithout = normalizeEndpoint(withoutLeading);

        expect(resultWith).toBe(resultWithout);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("api/0/ prefix is always stripped (CLI-K1)", async () => {
    await fcAssert(
      property(simplePathArb, (path) => {
        const withPrefix = `api/0/${path}`;
        const withoutPrefix = path;

        const resultWith = normalizeEndpoint(withPrefix);
        const resultWithout = normalizeEndpoint(withoutPrefix);

        expect(resultWith).toBe(resultWithout);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result never starts with api/0/ (CLI-K1)", async () => {
    await fcAssert(
      property(endpointArb, (endpoint) => {
        const result = normalizeEndpoint(endpoint);
        expect(result.startsWith("api/0/")).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("parseMethod properties", () => {
  test("valid methods always succeed and return uppercase", async () => {
    await fcAssert(
      property(validMethodArb, (method) => {
        const result = parseMethod(method);
        expect(result).toBe(method.toUpperCase() as typeof result);
        expect(["GET", "POST", "PUT", "DELETE", "PATCH"]).toContain(
          result as string
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("invalid methods always throw", async () => {
    await fcAssert(
      property(invalidMethodArb, (method) => {
        expect(() => parseMethod(method)).toThrow(/Invalid method/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result is always uppercase", async () => {
    await fcAssert(
      property(validMethodArb, (method) => {
        const result = parseMethod(method);
        expect(result).toBe((result as string).toUpperCase() as typeof result);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("parseFieldKey properties", () => {
  test("first segment is always the base key", async () => {
    await fcAssert(
      property(nestedFieldKeyArb, (key) => {
        const segments = parseFieldKey(key);
        // First segment should be the base (before any brackets)
        const expectedBase = key.split("[")[0];
        expect(segments[0]).toBe(expectedBase);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty key always throws", async () => {
    expect(() => parseFieldKey("")).toThrow(/Invalid field key format/);
  });

  test("key starting with bracket always throws", async () => {
    await fcAssert(
      property(fieldKeyBaseArb, (key) => {
        expect(() => parseFieldKey(`[${key}]`)).toThrow(
          /Invalid field key format/
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("segment count equals bracket count plus one", async () => {
    await fcAssert(
      property(nestedFieldKeyArb, (key) => {
        const segments = parseFieldKey(key);
        const bracketCount = (key.match(/\[/g) || []).length;
        expect(segments.length).toBe(bracketCount + 1);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("setNestedValue security properties", () => {
  test("__proto__ at any depth throws", async () => {
    await fcAssert(
      property(fieldKeyBaseArb, (key) => {
        const obj: Record<string, unknown> = {};

        // __proto__ as base key
        expect(() => setNestedValue(obj, "__proto__", "value")).toThrow(
          /"__proto__" is not allowed/
        );

        // __proto__ in brackets
        expect(() => setNestedValue(obj, `${key}[__proto__]`, "value")).toThrow(
          /"__proto__" is not allowed/
        );

        // __proto__ deeply nested
        expect(() =>
          setNestedValue(obj, `${key}[nested][__proto__]`, "value")
        ).toThrow(/"__proto__" is not allowed/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("constructor at any depth throws", async () => {
    await fcAssert(
      property(fieldKeyBaseArb, (key) => {
        const obj: Record<string, unknown> = {};

        expect(() => setNestedValue(obj, "constructor", "value")).toThrow(
          /"constructor" is not allowed/
        );

        expect(() =>
          setNestedValue(obj, `${key}[constructor]`, "value")
        ).toThrow(/"constructor" is not allowed/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("prototype at any depth throws", async () => {
    await fcAssert(
      property(fieldKeyBaseArb, (key) => {
        const obj: Record<string, unknown> = {};

        expect(() => setNestedValue(obj, "prototype", "value")).toThrow(
          /"prototype" is not allowed/
        );

        expect(() => setNestedValue(obj, `${key}[prototype]`, "value")).toThrow(
          /"prototype" is not allowed/
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("no prototype pollution occurs even if error handling fails", async () => {
    // Verify that even after attempting dangerous operations, no pollution occurred
    const testObj = {};
    const dangerousKeys = [
      "__proto__[polluted]",
      "constructor[prototype][polluted]",
    ];

    for (const key of dangerousKeys) {
      try {
        setNestedValue({}, key, true);
      } catch {
        // Expected to throw
      }
    }

    // Verify no pollution
    expect((testObj as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("setNestedValue behavior properties", () => {
  test("simple key sets top-level value", async () => {
    await fcAssert(
      property(tuple(fieldKeyBaseArb, plainStringArb), ([key, value]) => {
        const obj: Record<string, unknown> = {};
        setNestedValue(obj, key, value);
        expect(obj[key]).toBe(value);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("nested key creates nested structure", async () => {
    await fcAssert(
      property(
        tuple(fieldKeyBaseArb, fieldKeyBaseArb, plainStringArb),
        ([base, nested, value]) => {
          const obj: Record<string, unknown> = {};
          setNestedValue(obj, `${base}[${nested}]`, value);

          expect(obj[base]).toBeDefined();
          expect(typeof obj[base]).toBe("object");
          expect((obj[base] as Record<string, unknown>)[nested]).toBe(value);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("array push syntax creates array", async () => {
    await fcAssert(
      property(tuple(fieldKeyBaseArb, plainStringArb), ([key, value]) => {
        const obj: Record<string, unknown> = {};
        setNestedValue(obj, `${key}[]`, value);

        expect(Array.isArray(obj[key])).toBe(true);
        expect((obj[key] as unknown[])[0]).toBe(value);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("multiple array pushes append to array", async () => {
    await fcAssert(
      property(
        tuple(fieldKeyBaseArb, plainStringArb, plainStringArb),
        ([key, value1, value2]) => {
          const obj: Record<string, unknown> = {};
          setNestedValue(obj, `${key}[]`, value1);
          setNestedValue(obj, `${key}[]`, value2);

          expect(Array.isArray(obj[key])).toBe(true);
          const arr = obj[key] as unknown[];
          expect(arr.length).toBe(2);
          expect(arr[0]).toBe(value1);
          expect(arr[1]).toBe(value2);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty brackets in middle of path throws", async () => {
    await fcAssert(
      property(tuple(fieldKeyBaseArb, fieldKeyBaseArb), ([base, end]) => {
        const obj: Record<string, unknown> = {};
        expect(() => setNestedValue(obj, `${base}[][${end}]`, "value")).toThrow(
          /empty brackets \[\] can only appear at the end/
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("parseFieldValue properties", () => {
  test("valid JSON is parsed correctly", async () => {
    await fcAssert(
      property(jsonValueArb, (jsonStr) => {
        const result = parseFieldValue(jsonStr);
        const expected = JSON.parse(jsonStr);
        expect(result).toEqual(expected);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-JSON strings are returned as-is", async () => {
    await fcAssert(
      property(plainStringArb, (str) => {
        const result = parseFieldValue(str);
        expect(result).toBe(str);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty string returns empty string", () => {
    expect(parseFieldValue("")).toBe("");
  });

  test("JSON round-trip: stringify then parse returns equivalent value", async () => {
    const values = [true, false, null, 123, 3.14, "hello", [1, 2, 3], { a: 1 }];

    for (const value of values) {
      const jsonStr = JSON.stringify(value);
      const result = parseFieldValue(jsonStr);
      expect(result).toEqual(value);
    }
  });
});

// -- New property tests for --data/-d and JSON auto-detection (CLI-AF) --

/** Arbitrary JSON object with string values (for request bodies) */
const jsonObjectArb = dictionary(fieldKeyBaseArb, plainStringArb).filter(
  (d) => Object.keys(d).length > 0
);

/** JSON objects stringified */
const jsonObjectStringArb = jsonObjectArb.map((obj) => JSON.stringify(obj));

/** JSON arrays stringified */
const jsonArrayStringArb = array(jsonValue(), {
  minLength: 1,
  maxLength: 5,
}).map((arr) => JSON.stringify(arr));

/** Valid key=value field string */
const keyValueFieldArb = tuple(fieldKeyBaseArb, plainStringArb).map(
  ([k, v]) => `${k}=${v}`
);

/** Non-JSON, non-key=value field string (has no '=' and doesn't start with {/[) */
const bareFieldArb = stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,15}$/).filter(
  (s) => !(s.includes("=") || s.startsWith("{") || s.startsWith("["))
);

/**
 * Capture stderr output during a synchronous callback.
 * Used inside property() callbacks where beforeEach/afterEach aren't available.
 */
function captureStderr(fn: () => void): string {
  let output = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

describe("property: normalizeFields JSON guard", () => {
  test("JSON objects pass through unchanged — no colon mangling", async () => {
    await fcAssert(
      property(jsonObjectStringArb, (json) => {
        const output = captureStderr(() => {
          const result = normalizeFields([json]);
          expect(result).toEqual([json]);
        });
        expect(output).toBe("");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("JSON arrays pass through unchanged", async () => {
    await fcAssert(
      property(jsonArrayStringArb, (json) => {
        const output = captureStderr(() => {
          const result = normalizeFields([json]);
          expect(result).toEqual([json]);
        });
        expect(output).toBe("");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: parseDataBody", () => {
  test("round-trip: stringify(obj) → parseDataBody returns equivalent object", async () => {
    await fcAssert(
      property(jsonObjectArb, (obj) => {
        const result = parseDataBody(JSON.stringify(obj));
        expect(result).toEqual(obj);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-JSON strings are returned as-is", async () => {
    await fcAssert(
      property(plainStringArb, (s) => {
        const result = parseDataBody(s);
        expect(result).toBe(s);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: extractJsonBody", () => {
  test("key=value fields are never extracted as body", async () => {
    await fcAssert(
      property(
        array(keyValueFieldArb, { minLength: 1, maxLength: 5 }),
        (fields) => {
          const output = captureStderr(() => {
            const result = extractJsonBody(fields);
            expect(result.body).toBeUndefined();
            expect(result.remaining).toEqual(fields);
          });
          expect(output).toBe("");
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single JSON object is always extracted as body", async () => {
    await fcAssert(
      property(jsonObjectStringArb, (json) => {
        const output = captureStderr(() => {
          const result = extractJsonBody([json]);
          expect(result.body).toEqual(JSON.parse(json));
          expect(result.remaining).toBeUndefined();
        });
        expect(output).toContain("request body");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("count invariant: |remaining| + (body ? 1 : 0) === |input|", async () => {
    await fcAssert(
      property(
        tuple(
          oneof(jsonObjectStringArb, keyValueFieldArb, bareFieldArb),
          array(keyValueFieldArb, { minLength: 0, maxLength: 3 })
        ),
        ([first, rest]) => {
          const fields = [first, ...rest];
          captureStderr(() => {
            const result = extractJsonBody(fields);
            const remainingCount = result.remaining?.length ?? 0;
            const bodyCount = result.body !== undefined ? 1 : 0;
            expect(remainingCount + bodyCount).toBe(fields.length);
          });
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("two JSON objects always throws ValidationError", async () => {
    await fcAssert(
      property(jsonObjectStringArb, jsonObjectStringArb, (a, b) => {
        expect(() => extractJsonBody([a, b])).toThrow(ValidationError);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: buildFromFields", () => {
  test("GET never produces a body from JSON extraction", async () => {
    await fcAssert(
      property(jsonObjectStringArb, (json) => {
        const output = captureStderr(() => {
          // GET with a JSON field: should NOT extract body (throws instead)
          expect(() => buildFromFields("GET", { "raw-field": [json] })).toThrow(
            ValidationError
          );
        });
        // No hint emitted (extraction skipped for GET)
        expect(output).toBe("");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("PUT with only JSON body returns that body exactly", async () => {
    await fcAssert(
      property(jsonObjectStringArb, (json) => {
        captureStderr(() => {
          const result = buildFromFields("PUT", { "raw-field": [json] });
          expect(result.body).toEqual(JSON.parse(json));
          expect(result.params).toBeUndefined();
        });
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("PUT: JSON body + non-conflicting fields → merged body has all keys", async () => {
    // Generate JSON body keys and separate field keys that don't overlap
    await fcAssert(
      property(
        uniqueArray(fieldKeyBaseArb, { minLength: 2, maxLength: 6 }),
        (keys) => {
          // Split keys: first half for JSON body, second half for fields
          const mid = Math.ceil(keys.length / 2);
          const jsonKeys = keys.slice(0, mid);
          const fieldKeys = keys.slice(mid);
          if (fieldKeys.length === 0) return; // need at least 1 field key

          const jsonObj: Record<string, string> = {};
          for (const k of jsonKeys) jsonObj[k] = "json_val";
          const jsonStr = JSON.stringify(jsonObj);

          const fields = fieldKeys.map((k) => `${k}=field_val`);

          captureStderr(() => {
            const result = buildFromFields("PUT", {
              "raw-field": [jsonStr],
              field: fields,
            });

            // All keys from both sources should be present
            const body = result.body as Record<string, unknown>;
            for (const k of jsonKeys) {
              expect(body).toHaveProperty(k);
            }
            for (const k of fieldKeys) {
              expect(body).toHaveProperty(k);
            }
          });
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("PUT: JSON body + conflicting field key → throws ValidationError", async () => {
    await fcAssert(
      property(
        record({
          key: fieldKeyBaseArb,
          jsonVal: plainStringArb,
          fieldVal: plainStringArb,
        }),
        ({ key, jsonVal, fieldVal }) => {
          const jsonStr = JSON.stringify({ [key]: jsonVal });
          captureStderr(() => {
            expect(() =>
              buildFromFields("PUT", {
                "raw-field": [jsonStr],
                field: [`${key}=${fieldVal}`],
              })
            ).toThrow(ValidationError);
          });
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("PUT with only key=value fields: no hint emitted (no JSON extraction)", async () => {
    await fcAssert(
      property(
        array(keyValueFieldArb, { minLength: 1, maxLength: 5 }),
        (fields) => {
          const output = captureStderr(() => {
            const result = buildFromFields("PUT", { field: fields });
            expect(result.body).toBeDefined();
          });
          // No JSON hint — only colon-correction warnings might appear
          expect(output).not.toContain("request body");
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

const MOCK_STDIN = process.stdin as unknown as NodeJS.ReadStream & { fd: 0 };

describe("property: resolveBody", () => {
  test("--data always returns a body (no params)", async () => {
    await fcAssert(
      asyncProperty(jsonObjectStringArb, async (json) => {
        const result = await resolveBody(
          { method: "PUT", data: json },
          MOCK_STDIN
        );
        expect(result.body).toBeDefined();
        expect(result.params).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("--data + --input always throws", async () => {
    await fcAssert(
      asyncProperty(jsonObjectStringArb, async (json) => {
        await expect(
          resolveBody(
            { method: "PUT", data: json, input: "file.json" },
            MOCK_STDIN
          )
        ).rejects.toThrow(ValidationError);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("--data + fields always throws", async () => {
    await fcAssert(
      asyncProperty(
        jsonObjectStringArb,
        keyValueFieldArb,
        async (json, field) => {
          await expect(
            resolveBody(
              { method: "PUT", data: json, field: [field] },
              MOCK_STDIN
            )
          ).rejects.toThrow(ValidationError);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Dry-run property tests

/** Arbitrary for HTTP methods */

/** Arbitrary for clean API endpoint paths (no query string, for dry-run tests) */
const dryRunEndpointArb = stringMatching(
  /^[a-z][a-z0-9-]*\/[a-z0-9-]*\/$/
).filter((s) => s.length > 3 && s.length < 80);

/** Arbitrary for query param values */
const paramValueArb = stringMatching(/^[a-zA-Z0-9_-]+$/).filter(
  (s) => s.length > 0 && s.length < 40
);

/** Arbitrary for query param maps */
const paramsArb = dictionary(
  stringMatching(/^[a-zA-Z][a-zA-Z0-9_]*$/).filter(
    (s) => s.length > 0 && s.length < 20
  ),
  paramValueArb,
  { minKeys: 0, maxKeys: 3 }
);

describe("property: resolveRequestUrl", () => {
  test("always contains /api/0/ prefix", () => {
    fcAssert(
      property(dryRunEndpointArb, (endpoint) => {
        const url = resolveRequestUrl(endpoint);
        expect(url).toContain("/api/0/");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always contains the endpoint path", () => {
    fcAssert(
      property(dryRunEndpointArb, (endpoint) => {
        const url = resolveRequestUrl(endpoint);
        const normalized = endpoint.startsWith("/")
          ? endpoint.slice(1)
          : endpoint;
        expect(url).toContain(normalized);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("includes query string when params provided", () => {
    fcAssert(
      property(dryRunEndpointArb, paramsArb, (endpoint, params) => {
        const url = resolveRequestUrl(endpoint, params);
        if (Object.keys(params).length > 0) {
          expect(url).toContain("?");
          for (const key of Object.keys(params)) {
            expect(url).toContain(key);
          }
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: resolveEffectiveHeaders", () => {
  /** Arbitrary for custom header entries (non-content-type keys) */
  const headerKeyArb = stringMatching(/^X-[A-Za-z]{1,10}$/);
  const headerValueArb = string({ minLength: 1, maxLength: 20 });
  const customHeadersArb = dictionary(headerKeyArb, headerValueArb, {
    minKeys: 0,
    maxKeys: 3,
  });

  test("preserves all custom headers", () => {
    fcAssert(
      property(customHeadersArb, (custom) => {
        const result = resolveEffectiveHeaders(custom, undefined);
        for (const [key, value] of Object.entries(custom)) {
          expect(result[key]).toBe(value);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("auto-adds Content-Type for object bodies without it", () => {
    fcAssert(
      property(customHeadersArb, jsonValue(), (custom, body) => {
        // Ensure body is a non-null object (not string/number/boolean/null)
        if (body === null || body === undefined || typeof body !== "object") {
          return;
        }
        const result = resolveEffectiveHeaders(custom, body);
        expect(result["Content-Type"]).toBe("application/json");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("never adds Content-Type for string bodies", () => {
    fcAssert(
      property(customHeadersArb, string(), (custom, body) => {
        const result = resolveEffectiveHeaders(custom, body);
        // Should not have auto-added Content-Type (only custom headers)
        if (!custom["Content-Type"]) {
          expect(result["Content-Type"]).toBeUndefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("does not override explicit Content-Type", () => {
    const contentTypeArb = constantFrom(
      "text/plain",
      "text/xml",
      "application/x-www-form-urlencoded"
    );
    fcAssert(
      property(contentTypeArb, jsonValue(), (ct, body) => {
        const result = resolveEffectiveHeaders({ "Content-Type": ct }, body);
        expect(result["Content-Type"]).toBe(ct);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
