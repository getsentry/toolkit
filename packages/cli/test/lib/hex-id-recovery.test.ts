/**
 * Hex ID Recovery Tests — unit tests for pure helpers and the decision tree.
 *
 * The decision tree is driven via a stubbed adapter so we don't hit real APIs.
 * Adapter integration tests that mock `globalThis.fetch` live in
 * `test/isolated/lib/hex-id-recovery-adapters.test.ts` per AGENTS.md.
 *
 * Many table cases are drawn directly from real telemetry (see
 * `.opencode/plans/*quiet-planet.md`) — e.g. the CLI-1A8 `ios` input,
 * the 12-char truncated UI IDs in CLI-16G, the slug-like inputs in
 * CLI-16G / CLI-M0 / CLI-197, and the over-nested path from CLI-16G.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ResolutionError, ValidationError } from "../../src/lib/errors.js";
import {
  ADAPTERS,
  extractHexCandidate,
  type FuzzyLookupAdapter,
  handleRecoveryResult,
  isOverNestedPath,
  looksLikeSlug,
  MIN_FUZZY_PREFIX,
  preNormalize,
  recoverHexId,
  stripTrailingNonHex,
} from "../../src/lib/hex-id-recovery.js";

const VALID_32 = "c0a5a9d4dce44358ab4231fc3bead7e9";
const VALID_16 = "d3808597105ed493";
const CLEAN_CTX = { org: "my-org", project: "my-project" };

// ---------------------------------------------------------------------------
// preNormalize
// ---------------------------------------------------------------------------

describe("preNormalize", () => {
  test("lowercases and trims", () => {
    expect(preNormalize("  ABC123  ")).toEqual({ cleaned: "abc123" });
  });

  test("detects sentinel 'null'", () => {
    expect(preNormalize("null")).toEqual({
      cleaned: "null",
      sentinel: "null",
    });
  });

  test("detects sentinel 'latest'", () => {
    expect(preNormalize("LATEST")).toEqual({
      cleaned: "latest",
      sentinel: "latest",
    });
  });

  test("detects sentinel '@latest'", () => {
    expect(preNormalize("@latest")).toEqual({
      cleaned: "@latest",
      sentinel: "@latest",
    });
  });

  test("strips span- URL fragment prefix", () => {
    expect(preNormalize("span-abc12345")).toEqual({ cleaned: "abc12345" });
  });

  test("detects sentinel after URL prefix stripping", () => {
    // Regression: `span-null` must be classified as sentinel, not slug.
    // The sentinel check has to run AFTER prefix stripping to catch
    // shell variable leaks that went through URL builders.
    expect(preNormalize("span-null")).toEqual({
      cleaned: "null",
      sentinel: "null",
    });
    expect(preNormalize("event-latest")).toEqual({
      cleaned: "latest",
      sentinel: "latest",
    });
  });

  test("strips nested URL fragment prefixes (idempotency safety)", () => {
    // Ensures preNormalize is idempotent even on pathological inputs —
    // first pass would only peel the outer prefix without the loop.
    expect(preNormalize("span-span-abc")).toEqual({ cleaned: "abc" });
    expect(preNormalize("trace-txn-deadbeef")).toEqual({
      cleaned: "deadbeef",
    });
  });

  test("strips txn- URL fragment prefix", () => {
    expect(preNormalize("txn-abc123")).toEqual({ cleaned: "abc123" });
  });

  test("strips UUID dashes on full UUID", () => {
    const uuid = "c0a5a9d4-dce4-4358-ab42-31fc3bead7e9";
    expect(preNormalize(uuid)).toEqual({ cleaned: VALID_32 });
  });

  test("strips dashes on partial UUID", () => {
    expect(preNormalize("abc12345-6789")).toEqual({
      cleaned: "abc123456789",
    });
  });

  test("preserves dashes when dashless result starts with non-hex char", () => {
    // `human-interfaces` has `h` at the start which is NOT a hex digit
    // (hex = 0-9, a-f). Stripping would produce `humaninterfaces` which
    // doesn't start with hex, so dashes are preserved. Slug detection
    // happens downstream in `looksLikeSlug`.
    const { cleaned } = preNormalize("human-interfaces");
    expect(cleaned).toBe("human-interfaces");
  });

  test("strips dashes when dashless result starts with hex char", () => {
    // `abc12345-6789` → dashless `abc123456789` starts with `a` (hex) → strip.
    const { cleaned } = preNormalize("abc12345-6789");
    expect(cleaned).toBe("abc123456789");
  });
});

// ---------------------------------------------------------------------------
// stripTrailingNonHex
// ---------------------------------------------------------------------------

describe("stripTrailingNonHex", () => {
  test("strips 'ios' suffix from 32+3 hex input", () => {
    const input = `${VALID_32}ios`;
    expect(stripTrailingNonHex(input, 32)).toEqual({
      hex: VALID_32,
      stripped: "ios",
    });
  });

  test("returns null when input equals expectedLen", () => {
    expect(stripTrailingNonHex(VALID_32, 32)).toBeNull();
  });

  test("returns null when hex prefix is shorter than expectedLen (CLI-1A8 26+ios case)", () => {
    // The exact CLI-1A8 input has only 26 hex + "ios" = falls through to fuzzy
    expect(stripTrailingNonHex("c0a5a9d4dce44358ab4231fc3bios", 32)).toBeNull();
  });

  test("returns null for leading non-hex", () => {
    expect(stripTrailingNonHex(`xyz${VALID_32}`, 32)).toBeNull();
  });

  test("strips span ID trailing junk", () => {
    expect(stripTrailingNonHex(`${VALID_16}x`, 16)).toEqual({
      hex: VALID_16,
      stripped: "x",
    });
  });

  test("returns null for shorter input than expected", () => {
    expect(stripTrailingNonHex("abc", 32)).toBeNull();
  });

  test("returns null when trace ID passed to span-length strip (all-hex tail)", () => {
    // Regression: a 32-char trace ID mistakenly passed where a span ID is
    // expected must NOT be silently truncated to 16 chars. Stripping would
    // have returned `{hex: first-16, stripped: last-16}`, masking the
    // wrong-entity-type error. The null return lets validateSpanId's
    // targeted "looks like a trace ID" hint surface instead.
    expect(stripTrailingNonHex(VALID_32, 16)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractHexCandidate
// ---------------------------------------------------------------------------

describe("extractHexCandidate", () => {
  test("plain 8-hex prefix", () => {
    expect(extractHexCandidate("05d6975a")).toEqual({ prefix: "05d6975a" });
  });

  test("12-hex prefix (common UI truncation)", () => {
    expect(extractHexCandidate("05d6975ab9bb")).toEqual({
      prefix: "05d6975ab9bb",
    });
  });

  test("ASCII middle ellipsis", () => {
    expect(extractHexCandidate("abc123...def456")).toEqual({
      prefix: "abc123",
      suffix: "def456",
    });
  });

  test("Unicode middle ellipsis", () => {
    expect(extractHexCandidate("abc123\u2026def456")).toEqual({
      prefix: "abc123",
      suffix: "def456",
    });
  });

  test("suffix-only with leading ellipsis", () => {
    expect(extractHexCandidate("...def456")).toEqual({
      prefix: "",
      suffix: "def456",
    });
  });

  test("returns null for all non-hex input", () => {
    expect(extractHexCandidate("xyz")).toBeNull();
  });

  test("takes only leading hex run on non-hex suffix", () => {
    expect(extractHexCandidate("c0a5a9d4dce44358ab4231fc3bios")).toEqual({
      prefix: "c0a5a9d4dce44358ab4231fc3b",
    });
  });
});

// ---------------------------------------------------------------------------
// looksLikeSlug
// ---------------------------------------------------------------------------

describe("looksLikeSlug", () => {
  test.each([
    ["human-interfaces", true],
    ["apacta-2-wttd", true],
    ["uts-patient-app-7d", true],
    ["simpelweb-2ry", true],
    ["server-xn", true],
  ])("slug-like: %s → %p", (input, expected) => {
    expect(looksLikeSlug(input)).toBe(expected);
  });

  test.each([
    ["abc12345", false], // pure hex, no dash
    ["c0a5a9d4", false], // pure hex
    ["null", false], // sentinel
    ["a", false], // too short
    ["abc", false], // no dash
    ["a-b", false], // no alpha segment of 2+
  ])("not a slug: %s → %p", (input, expected) => {
    expect(looksLikeSlug(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// isOverNestedPath
// ---------------------------------------------------------------------------

describe("isOverNestedPath", () => {
  test("2 segments: not over-nested", () => {
    expect(isOverNestedPath("org/project")).toBe(false);
  });

  test("3 segments: not over-nested (org/project/id)", () => {
    expect(isOverNestedPath("org/project/abcdef12")).toBe(false);
  });

  test("4 segments: over-nested", () => {
    expect(isOverNestedPath("gohighlevel/highlevel-flutter/27bc063/abc")).toBe(
      true
    );
  });

  test("single segment: not over-nested", () => {
    expect(isOverNestedPath("abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recoverHexId decision tree — driven via stubbed adapters
// ---------------------------------------------------------------------------

describe("recoverHexId decision tree", () => {
  let originalAdapters: typeof ADAPTERS;

  beforeEach(() => {
    originalAdapters = { ...ADAPTERS };
  });

  afterEach(() => {
    // Restore original adapters
    for (const key of Object.keys(
      originalAdapters
    ) as (keyof typeof ADAPTERS)[]) {
      ADAPTERS[key] = originalAdapters[key];
    }
  });

  function stubAdapter(entity: keyof typeof ADAPTERS, fn: FuzzyLookupAdapter) {
    ADAPTERS[entity] = fn;
  }

  test("sentinel-leak short-circuits without adapter call", async () => {
    let called = false;
    stubAdapter("event", async () => {
      called = true;
      return [];
    });
    const r = await recoverHexId("null", "event", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("sentinel-leak");
    expect(called).toBe(false);
  });

  test("over-nested path short-circuits", async () => {
    const r = await recoverHexId(
      "gohighlevel/highlevel-flutter/27bc063/abc",
      "event",
      CLEAN_CTX
    );
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("over-nested");
  });

  test("stripped recovery for <32hex>ios input", async () => {
    let called = false;
    stubAdapter("event", async () => {
      called = true;
      return [];
    });
    const r = await recoverHexId(`${VALID_32}ios`, "event", CLEAN_CTX);
    expect(r.kind).toBe("stripped");
    expect(r.kind === "stripped" && r.id).toBe(VALID_32);
    expect(r.kind === "stripped" && r.stripped).toBe("ios");
    expect(called).toBe(false);
  });

  test("fuzzy with single match returns fuzzy result (12-char UI truncation)", async () => {
    const fullId = `05d6975ab9bb${"0".repeat(20)}`;
    stubAdapter("event", async () => [fullId]);
    const r = await recoverHexId("05d6975ab9bb", "event", CLEAN_CTX);
    expect(r.kind).toBe("fuzzy");
    expect(r.kind === "fuzzy" && r.id).toBe(fullId);
    expect(r.kind === "fuzzy" && r.prefix).toBe("05d6975ab9bb");
  });

  test("fuzzy with multiple matches returns multiple-matches", async () => {
    const id1 = `05d6975ab9bb${"0".repeat(20)}`;
    const id2 = `05d6975ab9bb${"1".repeat(20)}`;
    stubAdapter("event", async () => [id1, id2]);
    const r = await recoverHexId("05d6975ab9bb", "event", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("multiple-matches");
    expect(r.kind === "failed" && r.candidates).toEqual([id1, id2]);
  });

  test("fuzzy with zero matches returns no-matches with retention hint", async () => {
    stubAdapter("event", async () => []);
    const r = await recoverHexId("05d6975ab9bb", "event", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("no-matches");
    expect(r.kind === "failed" && r.hint).toContain("32-character ID");
  });

  test("31-hex off-by-one falls through to fuzzy", async () => {
    // CLI-16G had `14d9a67fda344df0a138a88d62e41be` (31 chars)
    const full = "14d9a67fda344df0a138a88d62e41beb";
    stubAdapter("event", async () => [full]);
    const r = await recoverHexId(
      "14d9a67fda344df0a138a88d62e41be",
      "event",
      CLEAN_CTX
    );
    expect(r.kind).toBe("fuzzy");
    expect(r.kind === "fuzzy" && r.id).toBe(full);
  });

  test("too-short pure hex returns too-short", async () => {
    let called = false;
    stubAdapter("event", async () => {
      called = true;
      return [];
    });
    const r = await recoverHexId("abc", "event", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("too-short");
    expect(called).toBe(false);
  });

  test("looks-like-slug returns looks-like-slug (CLI-16G apacta-2-wttd)", async () => {
    const r = await recoverHexId("apacta-2-wttd", "event", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("looks-like-slug");
    expect(r.kind === "failed" && r.hint).toContain("issue list");
  });

  test("hex-starting slug (cafe-babe-app) classified as slug, not fuzzy-looked-up", async () => {
    // Regression: `cafe-babe-app` is clearly a project slug. preNormalize
    // strips the dashes (dashless starts with hex `c`) to `cafebabeapp`,
    // which has an 8+ char hex prefix that would trigger fuzzy lookup if
    // the slug check only ran in the too-short branch. The raw-input
    // slug check must fire first.
    let adapterCalled = false;
    stubAdapter("event", async () => {
      adapterCalled = true;
      return [];
    });
    const r = await recoverHexId("cafe-babe-app", "event", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("looks-like-slug");
    expect(adapterCalled).toBe(false);
  });

  test("looks-like-slug for trace → trace list hint (CLI-M0 frontend)", async () => {
    const r = await recoverHexId("frontend-app", "trace", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("looks-like-slug");
    expect(r.kind === "failed" && r.hint).toContain("trace list");
  });

  test("looks-like-slug for log (CLI-197 uts-patient-app-7d)", async () => {
    const r = await recoverHexId("uts-patient-app-7d", "log", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("looks-like-slug");
    expect(r.kind === "failed" && r.hint).toContain("log list");
  });

  test("adapter error returns api-error", async () => {
    stubAdapter("event", async () => {
      throw new Error("network fail");
    });
    const r = await recoverHexId("05d6975ab9bb", "event", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("api-error");
  });

  test("middle-ellipsis input drives prefix+suffix lookup (prefix ≥8)", async () => {
    // Prefix must be ≥ MIN_FUZZY_PREFIX (8) for adapter to be invoked.
    const fullId = `abcdef12${"0".repeat(18)}def456`;
    stubAdapter("log", async () => [fullId]);
    const r = await recoverHexId("abcdef12...def456", "log", CLEAN_CTX);
    expect(r.kind).toBe("fuzzy");
    expect(r.kind === "fuzzy" && r.suffix).toBe("def456");
  });

  test("middle-ellipsis with short prefix and long suffix (suffix ≥8) still triggers lookup", async () => {
    // Per the plan: either prefix OR suffix must be ≥ MIN_FUZZY_PREFIX.
    const fullId = `abc123${"0".repeat(18)}deadbeef12`;
    stubAdapter("log", async () => [fullId]);
    const r = await recoverHexId("abc123...deadbeef12", "log", CLEAN_CTX);
    expect(r.kind).toBe("fuzzy");
  });

  test("URL-prefixed valid span ID returns stripped result without adapter call", async () => {
    // Regression test: `span-<valid-16-hex>` is a valid span ID once the
    // `span-` prefix is stripped. Recovery should recognize this and return
    // immediately without invoking the fuzzy adapter (which might return
    // empty if the span is outside the scan window).
    let adapterCalled = false;
    stubAdapter("span", async () => {
      adapterCalled = true;
      return [];
    });
    const r = await recoverHexId(`span-${VALID_16}`, "span", {
      ...CLEAN_CTX,
      traceId: "a".repeat(32),
    });
    expect(r.kind).toBe("stripped");
    expect(r.kind === "stripped" && r.id).toBe(VALID_16);
    expect(r.kind === "stripped" && r.stripped).toBe("span-");
    expect(adapterCalled).toBe(false);
  });

  test("URL-prefixed valid event ID returns stripped result without adapter call", async () => {
    let adapterCalled = false;
    stubAdapter("event", async () => {
      adapterCalled = true;
      return [];
    });
    const r = await recoverHexId(`event-${VALID_32}`, "event", CLEAN_CTX);
    expect(r.kind).toBe("stripped");
    expect(r.kind === "stripped" && r.id).toBe(VALID_32);
    expect(adapterCalled).toBe(false);
  });

  test("URL-prefixed UUID-dashed valid event ID: stripped field describes transformation", async () => {
    // When preNormalize removes BOTH the URL prefix AND UUID dashes,
    // `cleaned` is no longer a literal substring of the lowercased raw
    // input. The stripped field should describe the transformation
    // (URL prefix + UUID dashes) rather than echoing the whole input.
    const uuidDashed = "c0a5a9d4-dce4-4358-ab42-31fc3bead7e9";
    stubAdapter("event", async () => []);
    const r = await recoverHexId(`event-${uuidDashed}`, "event", CLEAN_CTX);
    expect(r.kind).toBe("stripped");
    expect(r.kind === "stripped" && r.id).toBe(VALID_32);
    // stripped should not equal the entire input — should describe the
    // parts that were removed.
    if (r.kind === "stripped") {
      expect(r.stripped).not.toBe(`event-${uuidDashed}`);
      // Should mention the prefix and dashes were stripped.
      expect(r.stripped).toContain("event-");
    }
  });

  test("8-hex prefix for trace does NOT trigger cross-entity (needs 16 hex)", async () => {
    // tryCrossEntityRedirect only fires when input is exactly 16 chars
    // (SPAN_ID_RE). An 8-char prefix falls through to the fuzzy adapter.
    stubAdapter("trace", async () => []);
    const r = await recoverHexId("abcd1234", "trace", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("no-matches");
  });

  /** Build a 32-char UUIDv7 where the embedded timestamp is `date`. */
  function buildUuidV7(date: Date): string {
    const ts = date.getTime().toString(16).padStart(12, "0");
    // 12 time + 1 version (7) + 19 variant/rand = 32 total
    return `${ts}70008000000000000000`;
  }

  test("stripped UUIDv7 log ID past 90-day retention returns past-retention", async () => {
    // Input: <expired UUIDv7><trailing junk>. strip would normally succeed
    // but the stripped ID is past retention → recovery surfaces that
    // instead of returning a hex that will hit a 404 downstream.
    const past = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);
    const expiredLogId = buildUuidV7(past);
    expect(expiredLogId.length).toBe(32);
    const r = await recoverHexId(`${expiredLogId}ios`, "log", CLEAN_CTX);
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.reason).toBe("past-retention");
    expect(r.kind === "failed" && r.hint).toContain("90-day log retention");
  });

  test("stripped UUIDv7 log ID within retention returns stripped result", async () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const recentLogId = buildUuidV7(recent);
    const r = await recoverHexId(`${recentLogId}ios`, "log", CLEAN_CTX);
    expect(r.kind).toBe("stripped");
    expect(r.kind === "stripped" && r.id).toBe(recentLogId);
  });

  test("retention check skipped for non-v7 (v4) UUIDs — traces/events lack a hard cap", async () => {
    // A v4 UUID past a "retention-like" age — no hard cap on trace/event.
    // Strip returns normally; retention short-circuit doesn't fire.
    const v4Id = "c0a5a9d4dce44358ab4231fc3bead7e9";
    const r = await recoverHexId(`${v4Id}ios`, "trace", CLEAN_CTX);
    expect(r.kind).toBe("stripped");
  });
});

// ---------------------------------------------------------------------------
// handleRecoveryResult
// ---------------------------------------------------------------------------

describe("handleRecoveryResult", () => {
  const fallback = new ValidationError("Invalid event ID");
  const opts = {
    entityType: "event" as const,
    canonicalCommand: "sentry event view my-org/my-project/<id>",
    logTag: "test",
  };

  test("stripped returns the ID", () => {
    const id = handleRecoveryResult(
      {
        kind: "stripped",
        id: VALID_32,
        original: `${VALID_32}ios`,
        stripped: "ios",
      },
      fallback,
      opts
    );
    expect(id).toBe(VALID_32);
  });

  test("fuzzy returns the ID", () => {
    const id = handleRecoveryResult(
      {
        kind: "fuzzy",
        id: VALID_32,
        original: "05d6975ab9bb",
        prefix: "05d6975ab9bb",
      },
      fallback,
      opts
    );
    expect(id).toBe(VALID_32);
  });

  test("redirect returns the redirected ID", () => {
    const id = handleRecoveryResult(
      {
        kind: "redirect",
        id: VALID_32,
        original: VALID_16,
        fromEntity: "span",
        toEntity: "trace",
      },
      fallback,
      { ...opts, entityType: "trace" }
    );
    expect(id).toBe(VALID_32);
  });

  test("multiple-matches throws ResolutionError with candidates", () => {
    const id1 = `${"a".repeat(24)}0000aaaa`;
    const id2 = `${"a".repeat(24)}0000bbbb`;
    try {
      handleRecoveryResult(
        {
          kind: "failed",
          original: "aaaaaaaa",
          reason: "multiple-matches",
          candidates: [id1, id2],
        },
        fallback,
        opts
      );
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionError);
      expect((err as ResolutionError).message).toContain(id1);
      expect((err as ResolutionError).message).toContain(id2);
    }
  });

  test("sentinel-leak throws ValidationError", () => {
    try {
      handleRecoveryResult(
        {
          kind: "failed",
          original: "null",
          reason: "sentinel-leak",
          hint: "shell variable leak",
        },
        fallback,
        opts
      );
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain("shell variable");
    }
  });

  test("api-error preserves the original fallback error", () => {
    try {
      handleRecoveryResult(
        { kind: "failed", original: "abc", reason: "api-error" },
        fallback,
        opts
      );
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBe(fallback);
    }
  });
});

// ---------------------------------------------------------------------------
// MIN_FUZZY_PREFIX sanity
// ---------------------------------------------------------------------------

test("MIN_FUZZY_PREFIX matches Sentry UI getShortEventId (8 chars)", () => {
  expect(MIN_FUZZY_PREFIX).toBe(8);
});
