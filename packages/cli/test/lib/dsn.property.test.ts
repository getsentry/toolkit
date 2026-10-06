/**
 * Property-Based Tests for DSN Parsing
 *
 * Uses fast-check to verify properties that should always hold true
 * for the DSN parsing functions, regardless of input.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  nat,
  property,
  string,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  createDetectedDsn,
  createDsnFingerprint,
  extractOrgIdFromHost,
  inferPackagePath,
  isValidDsn,
  parseDsn,
} from "../../src/lib/dsn/parser.js";
import type { DetectedDsn } from "../../src/lib/dsn/types.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Arbitraries

/** Generate valid public keys (hex-like strings) */
const publicKeyArb = array(constantFrom(..."0123456789abcdef".split("")), {
  minLength: 8,
  maxLength: 32,
}).map((chars) => chars.join(""));

/** Generate valid positive project IDs (numeric strings) */
const projectIdArb = nat(9_999_999_998).map((id) => String(id + 1));

/** Generate valid positive org IDs (numeric) */
const orgIdArb = nat(9_999_998).map((id) => id + 1);

/** Generate region codes */
const regionArb = constantFrom("us", "de", "eu", "");

/** Generate valid SaaS ingest hosts with org ID */
const saasHostArb = tuple(orgIdArb, regionArb).map(([orgId, region]) =>
  region ? `o${orgId}.ingest.${region}.sentry.io` : `o${orgId}.ingest.sentry.io`
);

/** Generate self-hosted hosts (no org ID pattern) */
const selfHostedHostArb = constantFrom(
  "sentry.mycompany.com",
  "errors.internal.corp",
  "sentry.localhost",
  "my-sentry.example.org"
);

/** Generate complete valid DSN strings */
const validDsnArb = tuple(publicKeyArb, saasHostArb, projectIdArb).map(
  ([key, host, projectId]) => `https://${key}@${host}/${projectId}`
);

/** Generate valid self-hosted DSN strings */
const selfHostedDsnArb = tuple(
  publicKeyArb,
  selfHostedHostArb,
  projectIdArb
).map(([key, host, projectId]) => `https://${key}@${host}/${projectId}`);

/** Generate invalid DSN-like strings */
const invalidDsnArb = constantFrom(
  "",
  "not-a-dsn",
  "https://missing-key@sentry.io/",
  "https://@sentry.io/123", // empty key
  "ftp://key@sentry.io/123", // still valid URL, but will parse
  "https://key@/123", // no host
  "://key@sentry.io/123" // invalid protocol
);

/** Generate monorepo-style paths */
const monorepoPathArb = tuple(
  constantFrom("packages", "apps", "services", "libs"),
  array(constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
    minLength: 1,
    maxLength: 15,
  }),
  constantFrom("src/index.ts", ".env", "config.js", "main.py")
).map(([root, pkgChars, file]) => `${root}/${pkgChars.join("")}/${file}`);

/** Generate non-monorepo paths */
const rootPathArb = constantFrom(
  "src/index.ts",
  ".env",
  "config.js",
  "main.py",
  "index.js",
  "app/main.ts"
);

// Properties for parseDsn

describe("property: parseDsn", () => {
  test("successfully parses all valid DSN formats", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        const result = parseDsn(dsn);
        expect(result).not.toBeNull();
        expect(result?.protocol).toBe("https");
        expect(result?.publicKey).toBeDefined();
        expect(result?.host).toBeDefined();
        expect(result?.projectId).toBeDefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("extracts orgId from SaaS hosts", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        const result = parseDsn(dsn);
        // SaaS DSNs should have orgId extracted
        expect(result?.orgId).toBeDefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("orgId is undefined for self-hosted DSNs", () => {
    fcAssert(
      property(selfHostedDsnArb, (dsn) => {
        const result = parseDsn(dsn);
        expect(result).not.toBeNull();
        expect(result?.orgId).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns null for invalid DSNs", () => {
    fcAssert(
      property(invalidDsnArb, (dsn) => {
        const result = parseDsn(dsn);
        // Most invalid DSNs should return null
        // Some edge cases like ftp:// may still parse as valid URLs
        if (dsn === "" || dsn === "not-a-dsn" || dsn.includes("://key@/")) {
          expect(result).toBeNull();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("round-trip: parsed components reconstruct to equivalent DSN", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        const parsed = parseDsn(dsn);
        if (parsed) {
          const reconstructed = `${parsed.protocol}://${parsed.publicKey}@${parsed.host}/${parsed.projectId}`;
          expect(reconstructed).toBe(dsn);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for extractOrgIdFromHost

describe("property: extractOrgIdFromHost", () => {
  test("extracts org ID from valid SaaS ingest hosts", () => {
    fcAssert(
      property(tuple(orgIdArb, regionArb), ([orgId, region]) => {
        const host = region
          ? `o${orgId}.ingest.${region}.sentry.io`
          : `o${orgId}.ingest.sentry.io`;

        const result = extractOrgIdFromHost(host);
        expect(result).toBe(String(orgId));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns null for self-hosted hosts", () => {
    fcAssert(
      property(selfHostedHostArb, (host) => {
        const result = extractOrgIdFromHost(host);
        expect(result).toBeNull();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns null for malformed hosts", () => {
    const malformedHosts = constantFrom(
      "sentry.io",
      "ingest.sentry.io",
      "o.ingest.sentry.io", // no number
      "oabc.ingest.sentry.io", // letters instead of number
      "o123.sentry.io" // missing "ingest"
    );

    fcAssert(
      property(malformedHosts, (host) => {
        const result = extractOrgIdFromHost(host);
        expect(result).toBeNull();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for isValidDsn

describe("property: isValidDsn", () => {
  test("returns true for all valid DSNs", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        expect(isValidDsn(dsn)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns true for self-hosted DSNs", () => {
    fcAssert(
      property(selfHostedDsnArb, (dsn) => {
        expect(isValidDsn(dsn)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("consistent with parseDsn", () => {
    fcAssert(
      property(string({ maxLength: 100 }), (input) => {
        const isValid = isValidDsn(input);
        const parsed = parseDsn(input);
        expect(isValid).toBe(parsed !== null);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for createDetectedDsn

describe("property: createDetectedDsn", () => {
  test("returns null for invalid DSNs", () => {
    fcAssert(
      property(invalidDsnArb, (dsn) => {
        const result = createDetectedDsn(dsn, "env");
        // Should return null for truly invalid DSNs
        if (parseDsn(dsn) === null) {
          expect(result).toBeNull();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("preserves raw DSN string", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        const result = createDetectedDsn(dsn, "code", "src/index.ts");
        expect(result?.raw).toBe(dsn);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("preserves source metadata", () => {
    fcAssert(
      property(
        tuple(
          validDsnArb,
          constantFrom(
            "env" as const,
            "env_file" as const,
            "code" as const,
            "config" as const
          )
        ),
        ([dsn, source]) => {
          const result = createDetectedDsn(dsn, source, "test/path.ts");
          expect(result?.source).toBe(source);
          expect(result?.sourcePath).toBe("test/path.ts");
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for createDsnFingerprint

describe("property: createDsnFingerprint", () => {
  test("fingerprint is deterministic", () => {
    fcAssert(
      property(array(validDsnArb, { minLength: 1, maxLength: 5 }), (dsns) => {
        const detected = dsns
          .map((d) => createDetectedDsn(d, "code"))
          .filter((d): d is DetectedDsn => d !== null);

        const fp1 = createDsnFingerprint(detected);
        const fp2 = createDsnFingerprint(detected);
        expect(fp1).toBe(fp2);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("fingerprint is order-independent (sorted)", () => {
    fcAssert(
      property(array(validDsnArb, { minLength: 2, maxLength: 5 }), (dsns) => {
        const detected = dsns
          .map((d) => createDetectedDsn(d, "code"))
          .filter((d): d is DetectedDsn => d !== null);

        if (detected.length < 2) return;

        const fp1 = createDsnFingerprint(detected);
        const fp2 = createDsnFingerprint([...detected].reverse());
        expect(fp1).toBe(fp2);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("fingerprint deduplicates same DSN from multiple sources", () => {
    fcAssert(
      property(validDsnArb, (dsn) => {
        const detected1 = createDetectedDsn(dsn, "code", "src/a.ts");
        const detected2 = createDetectedDsn(dsn, "env_file", ".env");

        if (detected1 && detected2) {
          const fpSingle = createDsnFingerprint([detected1]);
          const fpDuplicate = createDsnFingerprint([detected1, detected2]);
          expect(fpSingle).toBe(fpDuplicate);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("different DSNs produce different fingerprints", () => {
    fcAssert(
      property(tuple(validDsnArb, validDsnArb), ([dsn1, dsn2]) => {
        if (dsn1 === dsn2) return; // Skip if same

        const detected1 = createDetectedDsn(dsn1, "code");
        const detected2 = createDetectedDsn(dsn2, "code");

        if (detected1 && detected2) {
          const fp1 = createDsnFingerprint([detected1]);
          const fp2 = createDsnFingerprint([detected2]);

          // Different DSNs should (usually) have different fingerprints
          // Unless they happen to have same orgId:projectId (unlikely with random data)
          if (
            detected1.projectId !== detected2.projectId ||
            detected1.orgId !== detected2.orgId
          ) {
            expect(fp1).not.toBe(fp2);
          }
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty array returns empty fingerprint", () => {
    const fp = createDsnFingerprint([]);
    expect(fp).toBe("");
  });

  test("fingerprint format is comma-separated key pairs", () => {
    fcAssert(
      property(array(validDsnArb, { minLength: 1, maxLength: 3 }), (dsns) => {
        const detected = dsns
          .map((d) => createDetectedDsn(d, "code"))
          .filter((d): d is DetectedDsn => d !== null);

        const fp = createDsnFingerprint(detected);

        // Should be comma-separated pairs or single pair
        if (fp.length > 0) {
          const parts = fp.split(",");
          for (const part of parts) {
            // Each part should be "prefix:projectId" format
            expect(part).toMatch(/^.+:.+$/);
          }
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for inferPackagePath

describe("property: inferPackagePath", () => {
  test("extracts package path from monorepo-style paths", () => {
    fcAssert(
      property(monorepoPathArb, (path) => {
        const result = inferPackagePath(path);
        expect(result).toBeDefined();

        // Should be "root/package" format
        const parts = result!.split("/");
        expect(parts.length).toBe(2);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns undefined for root-level paths", () => {
    fcAssert(
      property(rootPathArb, (path) => {
        const result = inferPackagePath(path);
        expect(result).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("handles edge cases gracefully", () => {
    const edgeCases = constantFrom("", "/", "a", "a/", "/a", "a/b");

    fcAssert(
      property(edgeCases, (path) => {
        // Should not throw
        const result = inferPackagePath(path);
        // Result should be either undefined or a valid path
        if (result !== undefined) {
          expect(result.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
