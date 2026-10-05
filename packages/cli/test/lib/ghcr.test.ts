/**
 * GHCR Client Tests
 *
 * Unit tests for the GHCR/OCI download protocol helpers.
 * All HTTP calls are mocked via globalThis.fetch to avoid network access.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UPGRADE_SOURCES } from "../../src/lib/binary.js";
import { UpgradeError } from "../../src/lib/errors.js";
import {
  downloadLayerBlob,
  downloadNightlyBlob,
  fetchManifest,
  fetchNightlyManifest,
  findLayerByFilename,
  GHCR_REPO,
  GHCR_TAG,
  GhcrManifestHttpError,
  getAnonymousToken,
  getNightlyVersion,
  listTags,
  type OciManifest,
} from "../../src/lib/ghcr.js";

/** Store original fetch for restoration */
let originalFetch: typeof globalThis.fetch;

/** Helper to mock fetch without TypeScript errors about missing Bun-specific properties */
function mockFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

/** Minimal valid OCI manifest for testing */
function makeManifest(overrides: Partial<OciManifest> = {}): OciManifest {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      digest: `sha256:${"0".repeat(64)}`,
      mediaType: "application/vnd.oci.empty.v1+json",
      size: 2,
    },
    layers: [
      {
        digest: `sha256:${"a".repeat(64)}`,
        mediaType: "application/octet-stream",
        size: 1000,
        annotations: {
          "org.opencontainers.image.title": "sentry-linux-x64.gz",
        },
      },
      {
        digest: `sha256:${"d".repeat(64)}`,
        mediaType: "application/octet-stream",
        size: 1200,
        annotations: {
          "org.opencontainers.image.title": "sentry-darwin-arm64.gz",
        },
      },
    ],
    annotations: {
      version: "0.0.0-dev.1740000000",
      "org.opencontainers.image.source": "https://github.com/getsentry/cli",
    },
    ...overrides,
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getAnonymousToken", () => {
  test("returns token from successful response", async () => {
    mockFetch(async (url) => {
      expect(String(url)).toContain(
        `https://ghcr.io/token?scope=repository:${GHCR_REPO}:pull`
      );
      return new Response(JSON.stringify({ token: "test-token-abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const token = await getAnonymousToken();
    expect(token).toBe("test-token-abc");
  });

  test("uses the selected source's GHCR repository", async () => {
    mockFetch(async (url) => {
      expect(String(url)).toContain("scope=repository:getsentry/toolkit:pull");
      return new Response(JSON.stringify({ token: "toolkit-token" }), {
        status: 200,
      });
    });

    await expect(getAnonymousToken(UPGRADE_SOURCES[0])).resolves.toBe(
      "toolkit-token"
    );
  });

  test("throws UpgradeError on HTTP error", async () => {
    mockFetch(async () => new Response("Unauthorized", { status: 401 }));

    await expect(getAnonymousToken()).rejects.toThrow(UpgradeError);
    await expect(getAnonymousToken()).rejects.toThrow(
      "GHCR token exchange failed: HTTP 401"
    );
  });

  test("throws UpgradeError on network failure", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(getAnonymousToken()).rejects.toThrow(UpgradeError);
    await expect(getAnonymousToken()).rejects.toThrow(
      "Failed to connect to GHCR: fetch failed"
    );
  });

  test("propagates caller cancellation without retrying", async () => {
    const controller = new AbortController();
    let requests = 0;
    mockFetch(async (_url, init) => {
      requests += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    });

    const request = getAnonymousToken(undefined, controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(1);
  });

  test("preserves a primitive caller cancellation reason without retrying", async () => {
    const controller = new AbortController();
    let requests = 0;
    mockFetch(async () => {
      requests += 1;
      controller.abort("cancelled");
      throw controller.signal.reason;
    });

    await expect(getAnonymousToken(undefined, controller.signal)).rejects.toBe(
      "cancelled"
    );
    expect(requests).toBe(1);
  });

  test("throws UpgradeError when response has no token field", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(getAnonymousToken()).rejects.toThrow(UpgradeError);
    await expect(getAnonymousToken()).rejects.toThrow(
      "GHCR token exchange returned no token"
    );
  });

  test("rejects a non-string token", async () => {
    mockFetch(async () => Response.json({ token: {} }));

    await expect(getAnonymousToken()).rejects.toThrow(
      "GHCR token exchange returned no token"
    );
  });

  test.each([" ", "\ttoken"])("rejects malformed token %j", async (token) => {
    mockFetch(async () => Response.json({ token }));

    await expect(getAnonymousToken()).rejects.toThrow(
      "GHCR token exchange returned no token"
    );
  });

  test("preserves cancellation during token body consumption", async () => {
    const controller = new AbortController();
    const reason = { kind: "cancelled" };
    mockFetch(async () => {
      const response = Response.json({ token: "unused" });
      response.json = async () => {
        controller.abort(reason);
        throw new DOMException("aborted", "AbortError");
      };
      return response;
    });

    await expect(getAnonymousToken(undefined, controller.signal)).rejects.toBe(
      reason
    );
  });
});

describe("fetchNightlyManifest", () => {
  test("fetches manifest with correct headers", async () => {
    const manifest = makeManifest();
    let capturedHeaders: Record<string, string> = {};

    mockFetch(async (url, init) => {
      expect(String(url)).toContain(`/v2/${GHCR_REPO}/manifests/${GHCR_TAG}`);
      capturedHeaders = Object.fromEntries(
        new Headers(init?.headers as HeadersInit).entries()
      );
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.oci.image.manifest.v1+json",
        },
      });
    });

    const result = await fetchNightlyManifest("my-token");
    expect(result).toEqual(manifest);
    expect(capturedHeaders.authorization).toBe("Bearer my-token");
    expect(capturedHeaders.accept).toBe(
      "application/vnd.oci.image.manifest.v1+json"
    );
  });

  test("uses the selected source's GHCR repository", async () => {
    const manifest = makeManifest();
    mockFetch(async (url) => {
      expect(String(url)).toContain("/v2/getsentry/toolkit/manifests/nightly");
      return new Response(JSON.stringify(manifest), { status: 200 });
    });

    await expect(
      fetchNightlyManifest("token", undefined, UPGRADE_SOURCES[0])
    ).resolves.toEqual(manifest);
  });

  test("throws UpgradeError on HTTP error", async () => {
    mockFetch(async () => new Response("Not Found", { status: 404 }));

    await expect(fetchNightlyManifest("token")).rejects.toThrow(UpgradeError);
    await expect(fetchNightlyManifest("token")).rejects.toThrow(
      'Failed to fetch manifest for tag "nightly": HTTP 404'
    );
  });

  test("throws UpgradeError on network failure", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(fetchNightlyManifest("token")).rejects.toThrow(UpgradeError);
    await expect(fetchNightlyManifest("token")).rejects.toThrow(
      'Failed to fetch manifest for tag "nightly": fetch failed'
    );
  });
});

describe("getNightlyVersion", () => {
  test("extracts version from manifest annotations", () => {
    const manifest = makeManifest();
    expect(getNightlyVersion(manifest)).toBe("0.0.0-dev.1740000000");
  });

  test("throws UpgradeError when version annotation is missing", () => {
    const manifest = makeManifest({ annotations: {} });
    expect(() => getNightlyVersion(manifest)).toThrow(UpgradeError);
    expect(() => getNightlyVersion(manifest)).toThrow(
      "Nightly manifest has no version annotation"
    );
  });

  test("throws UpgradeError when annotations object is absent", () => {
    const manifest = makeManifest({ annotations: undefined });
    expect(() => getNightlyVersion(manifest)).toThrow(UpgradeError);
  });

  test.each([
    "not-semver",
    "1.2.3",
    "1.2.3-dev.foo",
  ])("rejects invalid nightly version annotation %s", (version) => {
    const manifest = makeManifest({ annotations: { version } });

    expect(() => getNightlyVersion(manifest)).toThrow(
      "Nightly manifest has invalid version annotation"
    );
  });
});

describe("findLayerByFilename", () => {
  test("finds layer by filename annotation", () => {
    const manifest = makeManifest();
    const layer = findLayerByFilename(manifest, "sentry-linux-x64.gz");
    expect(layer.digest).toBe(`sha256:${"a".repeat(64)}`);
  });

  test("finds darwin layer", () => {
    const manifest = makeManifest();
    const layer = findLayerByFilename(manifest, "sentry-darwin-arm64.gz");
    expect(layer.digest).toBe(`sha256:${"d".repeat(64)}`);
  });

  test("throws UpgradeError when filename not found", () => {
    const manifest = makeManifest();
    expect(() =>
      findLayerByFilename(manifest, "sentry-freebsd-x64.gz")
    ).toThrow(UpgradeError);
    expect(() =>
      findLayerByFilename(manifest, "sentry-freebsd-x64.gz")
    ).toThrow("No nightly build found for sentry-freebsd-x64.gz");
  });

  test("throws UpgradeError when layer has no annotations", () => {
    const manifest = makeManifest({
      layers: [
        {
          digest: "sha256:noannotations",
          mediaType: "application/octet-stream",
          size: 100,
          // no annotations
        },
      ],
    });
    expect(() => findLayerByFilename(manifest, "sentry-linux-x64.gz")).toThrow(
      UpgradeError
    );
  });
});

describe("downloadNightlyBlob", () => {
  test("returns response directly when status is 200 (no redirect)", async () => {
    const binaryContent = new Uint8Array([1, 2, 3, 4]);
    mockFetch(async () => new Response(binaryContent, { status: 200 }));

    const response = await downloadNightlyBlob("token", "sha256:abc123");
    expect(response.status).toBe(200);
    const body = await response.arrayBuffer();
    expect(new Uint8Array(body)).toEqual(binaryContent);
  });

  test("follows 307 redirect without auth header", async () => {
    const binaryContent = new Uint8Array([5, 6, 7, 8]);
    let requestCount = 0;
    let secondRequestHeaders: Record<string, string> = {};

    mockFetch(async (_url, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        // First request: return 307 redirect to Azure
        return Response.redirect(
          "https://blob.storage.azure.com/signed?token=xyz",
          307
        );
      }
      // Second request: the actual download (no auth header expected)
      secondRequestHeaders = Object.fromEntries(
        new Headers(init?.headers as HeadersInit).entries()
      );
      return new Response(binaryContent, { status: 200 });
    });

    const response = await downloadNightlyBlob(
      "my-bearer-token",
      "sha256:abc123"
    );
    expect(requestCount).toBe(2);
    expect(response.status).toBe(200);
    // Auth header must NOT be forwarded to Azure
    expect(secondRequestHeaders.authorization).toBeUndefined();
    const body = await response.arrayBuffer();
    expect(new Uint8Array(body)).toEqual(binaryContent);
  });

  test("follows 302 redirect without auth header", async () => {
    let requestCount = 0;
    mockFetch(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.redirect("https://example.com/blob", 302);
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });

    await downloadNightlyBlob("token", "sha256:xyz");
    expect(requestCount).toBe(2);
  });

  test("throws UpgradeError when redirect has no Location header", async () => {
    mockFetch(async () => new Response(null, { status: 307 }));

    await expect(downloadNightlyBlob("token", "sha256:abc")).rejects.toThrow(
      UpgradeError
    );
    await expect(downloadNightlyBlob("token", "sha256:abc")).rejects.toThrow(
      "GHCR blob redirect (307) had no Location header"
    );
  });

  test("throws UpgradeError when blob storage download fails", async () => {
    let requestCount = 0;
    mockFetch(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.redirect("https://blob.storage.azure.com/file", 307);
      }
      return new Response("Forbidden", { status: 403 });
    });

    // Call once and capture to avoid stateful mock issues on repeated calls
    const error = await downloadNightlyBlob("token", "sha256:abc").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(UpgradeError);
    expect(error.message).toContain("Blob storage download failed: HTTP 403");
  });

  test("throws UpgradeError on unexpected status (not 200/redirect)", async () => {
    mockFetch(async () => new Response("Server Error", { status: 500 }));

    const error = await downloadNightlyBlob("token", "sha256:abc").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(UpgradeError);
    expect(error.message).toContain("Unexpected GHCR blob response: HTTP 500");
  });

  test("throws UpgradeError on network failure", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const error = await downloadNightlyBlob("token", "sha256:abc").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(UpgradeError);
    expect(error.message).toContain("Failed to connect to GHCR: fetch failed");
  });

  test("throws UpgradeError on network failure during redirect follow", async () => {
    let requestCount = 0;
    mockFetch(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.redirect("https://blob.storage.azure.com/file", 307);
      }
      throw new TypeError("fetch failed");
    });

    // Call once and capture to avoid stateful mock issues on repeated calls
    const error = await downloadNightlyBlob("token", "sha256:abc").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(UpgradeError);
    expect(error.message).toContain(
      "Failed to download from blob storage: fetch failed"
    );
  });

  test("preserves external cancellation during the GHCR blob request", async () => {
    const controller = new AbortController();
    let requestCount = 0;
    mockFetch(async () => {
      requestCount += 1;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(
      downloadNightlyBlob("token", "sha256:abc", controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requestCount).toBe(1);
  });

  test("preserves an arbitrary external cancellation reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    let requestCount = 0;
    mockFetch(async () => {
      requestCount += 1;
      controller.abort(reason);
      throw new TypeError("invalid_argument");
    });

    await expect(
      downloadNightlyBlob("token", "sha256:abc", controller.signal)
    ).rejects.toBe(reason);
    expect(requestCount).toBe(1);
  });

  test("preserves external cancellation during the redirect request", async () => {
    const controller = new AbortController();
    const reason = { kind: "cancelled" };
    const headers: Headers[] = [];
    mockFetch(async (_url, init) => {
      headers.push(new Headers(init?.headers));
      if (headers.length === 1) {
        return Response.redirect("https://blob.storage.azure.com/file", 307);
      }
      controller.abort(reason);
      throw new TypeError("invalid_argument");
    });

    await expect(
      downloadNightlyBlob("token", "sha256:abc", controller.signal)
    ).rejects.toBe(reason);
    expect(headers).toHaveLength(2);
    expect(headers[1]?.has("authorization")).toBe(false);
  });
});

// fetchManifest (generic tag variant)

describe("fetchManifest", () => {
  test.each([
    null,
    [],
    {},
    { schemaVersion: 2 },
    { schemaVersion: 2, layers: {} },
    { schemaVersion: 2, layers: [], annotations: ["value"] },
    {
      schemaVersion: 2,
      layers: [
        {
          digest: `sha256:${"a".repeat(64)}`,
          mediaType: "application/octet-stream",
          size: 1,
          annotations: ["value"],
        },
      ],
    },
  ])("rejects invalid OCI manifest %#", async (manifest) => {
    mockFetch(async () => Response.json(manifest));

    await expect(fetchManifest("token", "nightly")).rejects.toThrow(
      'Manifest for tag "nightly" returned invalid metadata'
    );
  });

  test("classifies manifest body termination as transport failure", async () => {
    mockFetch(async () => {
      const response = Response.json(makeManifest());
      response.json = async () => {
        throw new TypeError("terminated");
      };
      return response;
    });

    await expect(fetchManifest("token", "nightly")).rejects.toMatchObject({
      name: "UpgradeTransportError",
      reason: "network_error",
    });
  });
  test("fetches manifest for an arbitrary tag", async () => {
    const manifest = makeManifest();

    mockFetch(async (url) => {
      expect(String(url)).toContain(`/v2/${GHCR_REPO}/manifests/patch-0.13.0`);
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.oci.image.manifest.v1+json",
        },
      });
    });

    const result = await fetchManifest("token", "patch-0.13.0");
    expect(result).toEqual(manifest);
  });

  test("throws UpgradeError on HTTP 404", async () => {
    mockFetch(async () => new Response("Not Found", { status: 404 }));

    const error = await fetchManifest("token", "patch-0.13.0").catch(
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(GhcrManifestHttpError);
    expect(error).toMatchObject({
      name: "GhcrManifestHttpError",
      status: 404,
      message: 'Failed to fetch manifest for tag "patch-0.13.0": HTTP 404',
    });
  });

  test("throws UpgradeError on network failure", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(fetchManifest("token", "some-tag")).rejects.toThrow(
      UpgradeError
    );
    await expect(fetchManifest("token", "some-tag")).rejects.toThrow(
      'Failed to fetch manifest for tag "some-tag": fetch failed'
    );
  });
});

// listTags

describe("listTags", () => {
  test("rejects a repeated pagination cursor", async () => {
    const tags = Array.from({ length: 100 }, (_, index) => `tag-${index}`);
    let requests = 0;
    mockFetch(async () => {
      requests += 1;
      return Response.json({ tags });
    });

    await expect(listTags("token")).rejects.toThrow(
      "GHCR tag pagination returned a repeated cursor"
    );
    expect(requests).toBe(2);
  });
  test("returns all tags when no prefix filter", async () => {
    mockFetch(async (url) => {
      expect(String(url)).toContain(`/v2/${GHCR_REPO}/tags/list`);
      return new Response(
        JSON.stringify({ tags: ["nightly", "patch-0.13.0", "patch-0.14.0"] }),
        { status: 200 }
      );
    });

    const tags = await listTags("token");
    expect(tags).toEqual(["nightly", "patch-0.13.0", "patch-0.14.0"]);
  });

  test("filters tags by prefix", async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({ tags: ["nightly", "patch-0.13.0", "patch-0.14.0"] }),
          { status: 200 }
        )
    );

    const tags = await listTags("token", "patch-");
    expect(tags).toEqual(["patch-0.13.0", "patch-0.14.0"]);
  });

  test("returns empty array when no tags match prefix", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ tags: ["nightly", "latest"] }), {
          status: 200,
        })
    );

    const tags = await listTags("token", "patch-");
    expect(tags).toEqual([]);
  });

  test("returns empty array when response has no tags field", async () => {
    mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));

    const tags = await listTags("token");
    expect(tags).toEqual([]);
  });

  test("throws UpgradeError on HTTP error", async () => {
    mockFetch(async () => new Response("Error", { status: 500 }));

    await expect(listTags("token")).rejects.toThrow(UpgradeError);
    await expect(listTags("token")).rejects.toThrow(
      "Failed to list GHCR tags: HTTP 500"
    );
  });

  test("throws UpgradeError on network failure", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(listTags("token")).rejects.toThrow(UpgradeError);
    await expect(listTags("token")).rejects.toThrow(
      "Failed to list GHCR tags: fetch failed"
    );
  });

  test("paginates when first page is full (100 tags)", async () => {
    // Generate exactly 100 tags for page 1 (triggers pagination), then 2 for page 2
    const page1Tags = Array.from(
      { length: 100 },
      (_, i) => `tag-${String(i).padStart(3, "0")}`
    );
    const page2Tags = ["tag-100", "tag-101"];
    const responses = [page1Tags, page2Tags];
    let pageCall = 0;

    mockFetch(async () => {
      const tags = responses[pageCall] ?? [];
      pageCall += 1;
      return new Response(JSON.stringify({ tags }), { status: 200 });
    });

    const tags = await listTags("token");
    expect(tags).toHaveLength(102);
    expect(tags[0]).toBe("tag-000");
    expect(tags[99]).toBe("tag-099");
    expect(tags[100]).toBe("tag-100");
    expect(tags[101]).toBe("tag-101");
    expect(pageCall).toBe(2);
  });

  test("pagination with prefix filter only returns matching tags", async () => {
    // Mix of matching and non-matching tags, fewer than page size
    const mixedTags = Array.from({ length: 80 }, (_, i) => {
      if (i < 40) {
        return `patch-${i}`;
      }
      return `nightly-${i}`;
    });

    mockFetch(
      async () =>
        new Response(JSON.stringify({ tags: mixedTags }), {
          status: 200,
        })
    );

    const tags = await listTags("token", "patch-");
    expect(tags).toHaveLength(40);
    for (const tag of tags) {
      expect(tag.startsWith("patch-")).toBe(true);
    }
  });
});

// downloadLayerBlob

describe("downloadLayerBlob", () => {
  test("returns ArrayBuffer from blob download", async () => {
    const content = new Uint8Array([1, 2, 3, 4, 5]);
    let requestCount = 0;

    mockFetch(async (url) => {
      requestCount += 1;
      if (requestCount === 1) {
        expect(String(url)).toContain(`/v2/${GHCR_REPO}/blobs/sha256:abc123`);
        return Response.redirect("https://blob.storage.azure.com/file", 307);
      }
      return new Response(content, { status: 200 });
    });

    const result = await downloadLayerBlob("token", "sha256:abc123");
    expect(new Uint8Array(result)).toEqual(content);
  });

  test("throws UpgradeError on download failure", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(downloadLayerBlob("token", "sha256:abc")).rejects.toThrow(
      UpgradeError
    );
  });
});
