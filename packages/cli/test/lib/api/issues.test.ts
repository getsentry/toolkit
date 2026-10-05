/**
 * Tests for issue API helpers: parseResolveSpec + mergeIssues.
 *
 * Other issue API functions (list/get/update) are covered by
 * test/lib/api-client.coverage.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mergeIssues,
  parseResolveSpec,
  RESOLVE_COMMIT_EXPLICIT_PREFIX,
  RESOLVE_COMMIT_SENTINEL,
  RESOLVE_NEXT_RELEASE_SENTINEL,
} from "../../../src/lib/api-client.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { ApiError, ValidationError } from "../../../src/lib/errors.js";
import {
  getCachedResponse,
  storeCachedResponse,
} from "../../../src/lib/response-cache.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

describe("parseResolveSpec", () => {
  test("returns null for undefined", () => {
    expect(parseResolveSpec(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseResolveSpec("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(parseResolveSpec("   ")).toBeNull();
  });

  test("parses @next sentinel as static inNextRelease", () => {
    expect(parseResolveSpec(RESOLVE_NEXT_RELEASE_SENTINEL)).toEqual({
      kind: "static",
      details: { inNextRelease: true },
    });
  });

  test("parses bare @commit as commit/auto", () => {
    expect(parseResolveSpec(RESOLVE_COMMIT_SENTINEL)).toEqual({
      kind: "commit",
      spec: { kind: "auto" },
    });
  });

  test("parses explicit @commit:<repo>@<sha> as commit/explicit", () => {
    expect(
      parseResolveSpec(`${RESOLVE_COMMIT_EXPLICIT_PREFIX}getsentry/cli@abc123`)
    ).toEqual({
      kind: "commit",
      spec: { kind: "explicit", repository: "getsentry/cli", commit: "abc123" },
    });
  });

  test("explicit @commit splits on the LAST '@' (scoped repo names like @acme/web)", () => {
    expect(
      parseResolveSpec(`${RESOLVE_COMMIT_EXPLICIT_PREFIX}@acme/web@abc123`)
    ).toEqual({
      kind: "commit",
      spec: { kind: "explicit", repository: "@acme/web", commit: "abc123" },
    });
  });

  test("@commit:<repo>@<sha> rejects missing SHA", () => {
    expect(() =>
      parseResolveSpec(`${RESOLVE_COMMIT_EXPLICIT_PREFIX}getsentry/cli@`)
    ).toThrow(ValidationError);
  });

  test("@commit:<repo>@<sha> rejects missing repo", () => {
    expect(() =>
      parseResolveSpec(`${RESOLVE_COMMIT_EXPLICIT_PREFIX}@abc123`)
    ).toThrow(ValidationError);
  });

  test("@commit:<repo>@<sha> rejects payload with no '@' separator", () => {
    expect(() =>
      parseResolveSpec(`${RESOLVE_COMMIT_EXPLICIT_PREFIX}getsentry/cli`)
    ).toThrow(ValidationError);
  });

  test("treats any other value as static inRelease (including monorepo 'pkg@1.2.3')", () => {
    expect(parseResolveSpec("0.26.1")).toEqual({
      kind: "static",
      details: { inRelease: "0.26.1" },
    });
    expect(parseResolveSpec("v2.3.0")).toEqual({
      kind: "static",
      details: { inRelease: "v2.3.0" },
    });
    // Monorepo-style release — must NOT be mistaken for a commit spec
    // because it lacks the `@commit:` anchor.
    expect(parseResolveSpec("spotlight@1.2.3")).toEqual({
      kind: "static",
      details: { inRelease: "spotlight@1.2.3" },
    });
    expect(parseResolveSpec("my-release-tag")).toEqual({
      kind: "static",
      details: { inRelease: "my-release-tag" },
    });
  });

  test("trims surrounding whitespace from the version", () => {
    expect(parseResolveSpec("  0.26.1  ")).toEqual({
      kind: "static",
      details: { inRelease: "0.26.1" },
    });
  });

  test("sentinel matching is case-insensitive (@Next, @NEXT, @Commit, ...)", () => {
    // Users sometimes copy sentinels from docs with different casing, or
    // a stack frame name may be auto-capitalized. All variants must
    // normalize to the canonical sentinel, never silently fall through to
    // inRelease.
    expect(parseResolveSpec("@Next")).toEqual({
      kind: "static",
      details: { inNextRelease: true },
    });
    expect(parseResolveSpec("@NEXT")).toEqual({
      kind: "static",
      details: { inNextRelease: true },
    });
    expect(parseResolveSpec("@Commit")).toEqual({
      kind: "commit",
      spec: { kind: "auto" },
    });
    expect(parseResolveSpec("@COMMIT")).toEqual({
      kind: "commit",
      spec: { kind: "auto" },
    });
  });

  test("explicit @commit prefix is case-insensitive but preserves payload case", () => {
    expect(parseResolveSpec("@Commit:GetSentry/CLI@ABCDEF123")).toEqual({
      kind: "commit",
      spec: {
        kind: "explicit",
        repository: "GetSentry/CLI",
        commit: "ABCDEF123",
      },
    });
  });

  test("rejects unknown @-prefixed tokens instead of silent inRelease fallback", () => {
    // Typo guard: @netx, @commmit, @release, etc. must error instead of
    // quietly creating a release named "@netx". Releases cannot legally
    // start with @ in any supported format, so this is always a typo.
    expect(() => parseResolveSpec("@netx")).toThrow(ValidationError);
    expect(() => parseResolveSpec("@commmit")).toThrow(ValidationError);
    expect(() => parseResolveSpec("@release")).toThrow(ValidationError);
  });
});

describe("mergeIssues", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects fewer than 2 group IDs", async () => {
    await expect(mergeIssues("test-org", ["1"])).rejects.toThrow(
      ValidationError
    );
    await expect(mergeIssues("test-org", [])).rejects.toThrow(ValidationError);
  });

  test("sends PUT to org bulk-mutate endpoint with id= params and merge body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: unknown;

    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      capturedUrl = req.url;
      capturedMethod = req.method;
      capturedBody = await req.json();
      return new Response(
        JSON.stringify({
          merge: { parent: "100", children: ["200", "300"] },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    const result = await mergeIssues("test-org", ["100", "200", "300"]);

    expect(capturedMethod).toBe("PUT");
    expect(capturedUrl).toContain("/api/0/organizations/test-org/issues/");
    // All three IDs present as repeated query params
    expect(capturedUrl).toContain("id=100");
    expect(capturedUrl).toContain("id=200");
    expect(capturedUrl).toContain("id=300");
    expect(capturedBody).toEqual({ merge: 1 });
    expect(result).toEqual({ parent: "100", children: ["200", "300"] });
  });

  test("propagates API errors (e.g. 'Only error issues can be merged')", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify(["Only error issues can be merged."]), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(
      mergeIssues("test-org", ["100", "200"])
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("handles 204 No Content (no matching issues) gracefully", async () => {
    // Sentry's bulk mutate returns 204 when IDs are out of scope or the
    // matched set is empty — without a body. Previously this crashed with
    // SyntaxError in response.json().
    globalThis.fetch = mockFetch(
      async () =>
        new Response(null, {
          status: 204,
        })
    );

    await expect(
      mergeIssues("test-org", ["100", "200"])
    ).rejects.toBeInstanceOf(ApiError);
    await expect(mergeIssues("test-org", ["100", "200"])).rejects.toThrow(
      /no matching issues|out of scope/i
    );
  });
});

describe("mergeIssues: cross-origin legacy cache", () => {
  useTestConfigDir("merge-legacy-cache-");

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setAuthToken("test-token", 3600, "test-refresh");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("clears legacy /issues/{id}/ cache for every affected ID", async () => {
    // Regression: the HTTP-layer invalidation hook only sees
    // `organizations/{org}/issues/?id=...`, so it can't clear the
    // per-ID legacy caches under the control-silo origin
    // (`sentry.io/api/0/issues/{id}/`) that `getIssue()` reads.
    // mergeIssues must do it manually after the merge response
    // identifies the affected IDs.
    const legacyUrl = (id: string) => `https://sentry.io/api/0/issues/${id}/`;

    for (const id of ["100", "200", "300"]) {
      await storeCachedResponse(
        "GET",
        legacyUrl(id),
        {},
        new Response(JSON.stringify({ id }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      expect(await getCachedResponse("GET", legacyUrl(id), {})).toBeDefined();
    }

    globalThis.fetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            merge: { parent: "100", children: ["200", "300"] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );

    await mergeIssues("test-org", ["100", "200", "300"]);

    for (const id of ["100", "200", "300"]) {
      expect(await getCachedResponse("GET", legacyUrl(id), {})).toBeUndefined();
    }
  });
});
