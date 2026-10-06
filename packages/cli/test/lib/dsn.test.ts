/**
 * DSN Parsing Tests
 *
 * Note: Core invariants (parsing, validation, round-trips, fingerprint ordering/dedup)
 * are tested via property-based tests in dsn.property.test.ts. These tests focus on
 * edge cases and self-hosted DSN behavior that property generators don't cover.
 */

import { describe, expect, test } from "vitest";
import type { DetectedDsn } from "../../src/lib/dsn/index.js";
import {
  createDetectedDsn,
  createDsnFingerprint,
  inferPackagePath,
  isPlaceholderNumericId,
  isPlaceholderPublicKey,
  parseDsn,
} from "../../src/lib/dsn/index.js";

describe("parseDsn edge cases", () => {
  test("returns null for DSN without project ID (trailing slash)", () => {
    const dsn = "https://key@o123.ingest.sentry.io/";
    const result = parseDsn(dsn);
    expect(result).toBeNull();
  });

  test("handles DSN with path segments", () => {
    const dsn = "https://key@o123.ingest.sentry.io/api/456";
    const result = parseDsn(dsn);
    expect(result?.projectId).toBe("456");
  });

  test.each([
    // Canonical sentry-docs codeContext default
    "https://examplePublicKey@o0.ingest.sentry.io/0",
    // Docs example with bare `public` key + o0 host (rejected via org id)
    "https://public@o0.ingest.sentry.io/1",
    // All-zero padded org host used in OTLP docs examples
    "https://abc123@o00000.ingest.sentry.io/1111111",
    // Zero project ID only
    "https://key@o123.ingest.sentry.io/0",
    // Zero SaaS org ID only
    "https://key@o0.ingest.sentry.io/456",
    // Angle-bracket template keys (URL-encoded by the parser)
    "https://%3Ckey%3E@o123.ingest.sentry.io/456",
    "https://YOUR_DSN_HERE@o123.ingest.sentry.io/456",
    "https://___PUBLIC_DSN___@o123.ingest.sentry.io/456",
    "https://__DSN__@o123.ingest.sentry.io/456",
  ])("returns null for docs placeholder DSN %s", (dsn) => {
    expect(parseDsn(dsn)).toBeNull();
  });

  test("still accepts a real-looking SaaS DSN", () => {
    const dsn =
      "https://abc123def456@o1169445.ingest.us.sentry.io/4505229541441536";
    const result = parseDsn(dsn);
    expect(result).toEqual({
      protocol: "https",
      publicKey: "abc123def456",
      host: "o1169445.ingest.us.sentry.io",
      projectId: "4505229541441536",
      orgId: "1169445",
    });
  });

  test("still accepts legacy public:secret DSNs with real org/project ids", () => {
    // Bare "public" is a valid public key in legacy DSNs; do not reject it alone.
    const dsn = "https://public:secret@o123.ingest.sentry.io/456";
    const result = parseDsn(dsn);
    expect(result).toEqual({
      protocol: "https",
      publicKey: "public",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
    });
  });
});

describe("placeholder helpers", () => {
  test.each(["0", "00", "00000"])("isPlaceholderNumericId accepts %s", (id) => {
    expect(isPlaceholderNumericId(id)).toBe(true);
  });

  test.each([
    "1",
    "10",
    "1169445",
  ])("isPlaceholderNumericId rejects %s", (id) => {
    expect(isPlaceholderNumericId(id)).toBe(false);
  });

  test.each([
    "examplePublicKey",
    "exampleKey",
    "YOUR_DSN_HERE",
    "___PUBLIC_DSN___",
    "__DSN__",
    "<key>",
  ])("isPlaceholderPublicKey accepts %s", (key) => {
    expect(isPlaceholderPublicKey(key)).toBe(true);
  });

  test.each([
    "abc123def456",
    "public",
    "publickey",
    "public-app-key",
  ])("isPlaceholderPublicKey rejects %s", (key) => {
    expect(isPlaceholderPublicKey(key)).toBe(false);
  });
});

describe("createDsnFingerprint: self-hosted DSNs", () => {
  test("includes DSNs without orgId using host as prefix", () => {
    const saas: DetectedDsn = {
      raw: "https://key@o123.ingest.sentry.io/456",
      protocol: "https",
      publicKey: "key",
      host: "o123.ingest.sentry.io",
      projectId: "456",
      orgId: "123",
      source: "env",
    };
    const selfHosted: DetectedDsn = {
      raw: "https://key@sentry.mycompany.com/1",
      protocol: "https",
      publicKey: "key",
      host: "sentry.mycompany.com",
      projectId: "1",
      orgId: undefined,
      source: "env",
    };

    const result = createDsnFingerprint([saas, selfHosted]);
    expect(result).toBe("123:456,sentry.mycompany.com:1");
  });

  test("returns host-based fingerprint for self-hosted DSNs", () => {
    const selfHosted: DetectedDsn = {
      raw: "https://key@sentry.mycompany.com/1",
      protocol: "https",
      publicKey: "key",
      host: "sentry.mycompany.com",
      projectId: "1",
      orgId: undefined,
      source: "env",
    };

    const result = createDsnFingerprint([selfHosted]);
    expect(result).toBe("sentry.mycompany.com:1");
  });
});

describe("createDetectedDsn edge cases", () => {
  test("includes packagePath when provided", () => {
    const result = createDetectedDsn(
      "https://abc123@o123.ingest.sentry.io/456",
      "code",
      "packages/web/src/config.ts",
      "packages/web"
    );
    expect(result?.packagePath).toBe("packages/web");
  });
});

describe("inferPackagePath", () => {
  test("infers package path from packages/ directory", () => {
    expect(inferPackagePath("packages/frontend/src/index.ts")).toBe(
      "packages/frontend"
    );
  });

  test("infers package path from apps/ directory", () => {
    expect(inferPackagePath("apps/web/.env")).toBe("apps/web");
  });

  test("infers package path from services/ directory", () => {
    expect(inferPackagePath("services/api/server.ts")).toBe("services/api");
  });

  test("infers package path from modules/ directory", () => {
    // Property generator only uses packages/apps/services/libs — modules/ is not covered
    expect(inferPackagePath("modules/auth/index.ts")).toBe("modules/auth");
  });

  test("returns undefined for non-monorepo directories", () => {
    expect(inferPackagePath("other/path/file.ts")).toBeUndefined();
  });
});
