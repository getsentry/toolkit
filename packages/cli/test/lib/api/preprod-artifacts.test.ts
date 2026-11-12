/**
 * Tests for the preprod-artifacts (mobile build) API.
 *
 * Pure URL helpers are tested directly. Calls that use `@sentry/api`
 * operations get an SDK config whose `fetch` is mocked; calls still on
 * `apiRequestToRegion` mock that helper. `downloadBuildArtifact` mocks
 * `customFetch` and the
 * auth-token getter so the streaming write and — critically — the
 * same-origin-only auth attachment can be verified without a network.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { parse, safeParse } from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, EXIT, ValidationError } from "../../../src/lib/errors.js";

const {
  customFetchMock,
  apiRequestToRegionMock,
  getAuthTokenMock,
  sdkFetchMock,
  uploadMissingChunksMock,
} = vi.hoisted(() => ({
  customFetchMock: vi.fn(),
  apiRequestToRegionMock: vi.fn(),
  getAuthTokenMock: vi.fn<() => string | undefined>(() => "secret-token"),
  sdkFetchMock: vi.fn<(request: Request) => Promise<Response>>(),
  uploadMissingChunksMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/lib/region.js", () => ({
  resolveOrgRegion: vi.fn(async () => "https://us.sentry.io"),
}));
vi.mock("../../../src/lib/api/infrastructure.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/lib/api/infrastructure.js")
    >();
  return {
    ...actual,
    apiRequestToRegion: apiRequestToRegionMock,
    getOrgSdkConfig: vi.fn(() => ({
      baseUrl: "https://us.sentry.io",
      fetch: sdkFetchMock,
      throwOnError: false as const,
    })),
  };
});
vi.mock("../../../src/lib/custom-ca.js", () => ({
  customFetch: customFetchMock,
}));
vi.mock("../../../src/lib/db/auth.js", () => ({
  getAuthToken: getAuthTokenMock,
}));
vi.mock("../../../src/lib/api/chunk-upload.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/lib/api/chunk-upload.js")
    >();
  return {
    ...actual,
    getChunkUploadOptions: vi.fn(async () => ({
      url: "https://us.sentry.io/api/0/chunk-upload/",
      chunkSize: 8192,
      chunksPerRequest: 64,
      maxRequestSize: 1_048_576,
      hashAlgorithm: "sha1",
      concurrency: 8,
      compression: ["gzip"],
    })),
    uploadMissingChunks: uploadMissingChunksMock,
  };
});

import { getOrgSdkConfig } from "../../../src/lib/api/infrastructure.js";
import {
  buildFormatFromUrl,
  createPreprodSnapshot,
  downloadBuildArtifact,
  fetchSnapshotsUploadOptions,
  getBuildInstallDetails,
  getLatestBaseSnapshot,
  LatestBaseSnapshotSchema,
  openSnapshotArchive,
  toBinaryDownloadUrl,
  uploadBuild,
  waitForSnapshotArchive,
} from "../../../src/lib/api/preprod-artifacts.js";

describe("toBinaryDownloadUrl", () => {
  test("rewrites a plist manifest URL to fetch the ipa binary", () => {
    expect(
      toBinaryDownloadUrl("https://us.sentry.io/dl/?response_format=plist"),
    ).toBe("https://us.sentry.io/dl/?response_format=ipa");
  });

  test("leaves non-plist URLs unchanged", () => {
    expect(
      toBinaryDownloadUrl("https://us.sentry.io/dl/?response_format=apk"),
    ).toBe("https://us.sentry.io/dl/?response_format=apk");
  });
});

describe("buildFormatFromUrl", () => {
  test("detects ipa", () => {
    expect(buildFormatFromUrl("https://x/?response_format=ipa")).toBe("ipa");
  });
  test("detects apk", () => {
    expect(buildFormatFromUrl("https://x/?response_format=apk")).toBe("apk");
  });
  test("throws on an unrecognized format", () => {
    expect(() => buildFormatFromUrl("https://x/?response_format=zip")).toThrow(
      ValidationError,
    );
  });
});

describe("getBuildInstallDetails", () => {
  beforeEach(() => {
    sdkFetchMock.mockReset();
  });

  test("hits the install-details endpoint and returns parsed data", async () => {
    sdkFetchMock.mockResolvedValue(
      Response.json({ isInstallable: true, installUrl: "https://u/" }),
    );

    const result = await getBuildInstallDetails("my-org", "build 1");

    expect(result).toEqual({ isInstallable: true, installUrl: "https://u/" });
    const request = sdkFetchMock.mock.calls.at(-1)?.[0];
    expect(request?.method).toBe("GET");
    // Build id is URL-encoded into the path.
    expect(request?.url).toBe(
      "https://us.sentry.io/api/0/organizations/my-org/preprodartifacts/build%201/install-details/",
    );
  });

  test("rejects a response that does not match the schema", async () => {
    sdkFetchMock.mockResolvedValue(Response.json({ installUrl: 42 }));

    await expect(getBuildInstallDetails("my-org", "b1")).rejects.toThrow(
      "Unexpected response format from organizations/my-org/preprodartifacts/b1/install-details/",
    );
  });
});

describe("downloadBuildArtifact", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "preprod-dl-"));
    customFetchMock.mockReset();
    getAuthTokenMock.mockReturnValue("secret-token");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("streams the body to disk and attaches auth for a same-origin URL", async () => {
    customFetchMock.mockResolvedValue(
      new Response("FAKE-BINARY", { status: 200 }),
    );
    const dest = join(tmpDir, "out.ipa");

    await downloadBuildArtifact(
      "https://us.sentry.io",
      "https://us.sentry.io/dl/?response_format=ipa",
      dest,
    );

    expect(await readFile(dest, "utf8")).toBe("FAKE-BINARY");
    const init = customFetchMock.mock.calls.at(-1)?.[1] as {
      headers: Record<string, string>;
    };
    expect(init.headers.Authorization).toBe("Bearer secret-token");
  });

  test("rejects a malformed bearer before downloading a build or snapshot", async () => {
    getAuthTokenMock.mockReturnValue("synthetic-prefix\nsynthetic-secret-tail");
    for (const download of [
      () =>
        downloadBuildArtifact(
          "https://us.sentry.io",
          "https://us.sentry.io/dl/?response_format=ipa",
          join(tmpDir, "out.ipa"),
        ),
      () => openSnapshotArchive("my-org", "snap-1"),
    ]) {
      const error = await download().catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        reason: "invalid",
        exitCode: EXIT.AUTH_INVALID,
      });
      expect(String(error)).not.toContain("synthetic-secret-tail");
    }
    expect(customFetchMock).not.toHaveBeenCalled();
  });

  test("does NOT attach the auth token to a cross-origin (signed) URL", async () => {
    customFetchMock.mockResolvedValue(new Response("X", { status: 200 }));

    await downloadBuildArtifact(
      "https://us.sentry.io",
      "https://cdn.example.com/blob?response_format=ipa",
      join(tmpDir, "o2.ipa"),
    );

    const init = customFetchMock.mock.calls.at(-1)?.[1] as {
      headers: Record<string, string>;
    };
    expect(init.headers.Authorization).toBeUndefined();
  });

  test("omits auth when no token is available", async () => {
    getAuthTokenMock.mockReturnValue(undefined);
    customFetchMock.mockResolvedValue(new Response("X", { status: 200 }));

    await downloadBuildArtifact(
      "https://us.sentry.io",
      "https://us.sentry.io/dl/?response_format=ipa",
      join(tmpDir, "o3.ipa"),
    );

    const init = customFetchMock.mock.calls.at(-1)?.[1] as {
      headers: Record<string, string>;
    };
    expect(init.headers.Authorization).toBeUndefined();
  });

  test("throws ApiError on a non-2xx response", async () => {
    customFetchMock.mockResolvedValue(
      new Response("nope", { status: 404, statusText: "Not Found" }),
    );

    await expect(
      downloadBuildArtifact(
        "https://us.sentry.io",
        "https://us.sentry.io/dl/?response_format=ipa",
        join(tmpDir, "o4.ipa"),
      ),
    ).rejects.toThrow(ApiError);
  });
});

/** JSON body of the last SDK request, decompressing a zstd body. */
async function lastSdkRequestBody(): Promise<Record<string, unknown>> {
  const request = sdkFetchMock.mock.calls.at(-1)?.[0];
  if (!request) {
    throw new Error("no SDK request was sent");
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  const json =
    request.headers.get("Content-Encoding") === "zstd"
      ? zstdDecompressSync(bytes).toString()
      : bytes.toString();
  return JSON.parse(json);
}

describe("uploadBuild", () => {
  let contentPath: string;
  let buildTmpDir: string;

  beforeEach(async () => {
    sdkFetchMock.mockReset();
    vi.mocked(getOrgSdkConfig).mockClear();
    uploadMissingChunksMock.mockClear();
    buildTmpDir = await mkdtemp(join(tmpdir(), "preprod-build-"));
    contentPath = join(buildTmpDir, "normalized.zip");
    await writeFile(contentPath, Buffer.from("normalized-build-zip-bytes"));
  });

  afterEach(async () => {
    await rm(buildTmpDir, { recursive: true, force: true });
  });

  test("returns the artifactUrl and folds metadata into the assemble body", async () => {
    sdkFetchMock.mockResolvedValue(
      Response.json({
        state: "ok",
        artifactUrl: "https://sentry.io/artifact/1",
      }),
    );

    const url = await uploadBuild({
      org: "my-org",
      project: "my-project",
      contentPath,
      metadata: {
        buildConfiguration: "Release",
        releaseNotes: "notes",
        installGroups: ["qa", "beta"],
      },
    });

    expect(url).toBe("https://sentry.io/artifact/1");
    const request = sdkFetchMock.mock.calls.at(-1)?.[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      "https://us.sentry.io/api/0/projects/my-org/my-project/files/preprodartifacts/assemble/",
    );
    const body = await lastSdkRequestBody();
    expect(body.checksum).toEqual(expect.any(String));
    expect(Array.isArray(body.chunks)).toBe(true);
    expect(body.build_configuration).toBe("Release");
    expect(body.release_notes).toBe("notes");
    expect(body.install_groups).toEqual(["qa", "beta"]);
    // Opted into transport retries: the poll loop re-sends the same body anyway.
    expect(getOrgSdkConfig).toHaveBeenCalledWith({ idempotent: true });
    // No missing chunks on the first (and only) response.
    expect(uploadMissingChunksMock).not.toHaveBeenCalled();
  });

  test("uploads missing chunks then returns the artifactUrl", async () => {
    // Real timers: uploadBuild now hashes the wrapper via async file I/O before
    // the first assemble POST, which does not interleave cleanly with fake
    // timers. The single real inter-poll sleep (~1s) is tolerable.
    sdkFetchMock
      .mockResolvedValueOnce(
        Response.json({ state: "created", missingChunks: ["deadbeef"] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          state: "ok",
          artifactUrl: "https://sentry.io/artifact/2",
        }),
      );

    await expect(
      uploadBuild({
        org: "my-org",
        project: "my-project",
        contentPath,
        metadata: {},
      }),
    ).resolves.toBe("https://sentry.io/artifact/2");
    expect(uploadMissingChunksMock).toHaveBeenCalledTimes(1);
  });

  test("flattens vcs fields into the top level of the assemble body", async () => {
    sdkFetchMock.mockResolvedValue(
      Response.json({
        state: "ok",
        artifactUrl: "https://sentry.io/artifact/9",
      }),
    );

    await uploadBuild({
      org: "my-org",
      project: "my-project",
      contentPath,
      metadata: { vcs: { head_sha: "abc", provider: "github", pr_number: 3 } },
    });

    const body = await lastSdkRequestBody();
    // Flattened alongside checksum/chunks — not nested under a "vcs" key.
    expect(body.head_sha).toBe("abc");
    expect(body.provider).toBe("github");
    expect(body.pr_number).toBe(3);
    expect(body).not.toHaveProperty("vcs");
  });

  test("omits optional metadata fields when unset", async () => {
    sdkFetchMock.mockResolvedValue(
      Response.json({
        state: "ok",
        artifactUrl: "https://sentry.io/artifact/3",
      }),
    );

    await uploadBuild({
      org: "my-org",
      project: "my-project",
      contentPath,
      metadata: {},
    });

    const body = await lastSdkRequestBody();
    expect(Object.keys(body).sort()).toEqual(["checksum", "chunks"]);
  });

  test("throws ApiError when assembly reports an error", async () => {
    sdkFetchMock.mockResolvedValue(
      Response.json({ state: "error", detail: "bad build" }),
    );

    await expect(
      uploadBuild({
        org: "my-org",
        project: "my-project",
        contentPath,
        metadata: {},
      }),
    ).rejects.toThrow(ApiError);
  });

  test("fails fast when finished (ok) without an artifact URL", async () => {
    sdkFetchMock.mockResolvedValue(Response.json({ state: "ok" }));

    await expect(
      uploadBuild({
        org: "my-org",
        project: "my-project",
        contentPath,
        metadata: {},
      }),
    ).rejects.toThrow(/no artifact URL/i);
  });
});

describe("snapshots", () => {
  beforeEach(() => {
    apiRequestToRegionMock.mockReset();
    customFetchMock.mockReset();
  });

  test("LatestBaseSnapshotSchema expects snake_case (server contract)", () => {
    // The server returns snake_case; the schema must accept it and reject
    // camelCase, guarding against the C1 regression.
    expect(
      safeParse(LatestBaseSnapshotSchema, {
        head_artifact_id: "art-1",
        image_count: 5,
      }).success,
    ).toBe(true);
    expect(
      safeParse(LatestBaseSnapshotSchema, {
        headArtifactId: "art-1",
        imageCount: 5,
      }).success,
    ).toBe(false);
  });

  test.each([
    { usecase: "preprod_snapshots", expectedUsecase: "preprod_snapshots" },
    { usecase: "preprod", expectedUsecase: "preprod" },
    { usecase: undefined, expectedUsecase: "preprod" },
  ])(
    "fetchSnapshotsUploadOptions negotiates auto and parses $usecase as $expectedUsecase",
    async ({ usecase, expectedUsecase }) => {
      apiRequestToRegionMock.mockImplementation(
        async (_region, _path, { schema }) => ({
          data: parse(schema, {
            objectstore: {
              url: "https://os.example.com",
              usecase,
              scopes: [["org", "1"]],
              authToken: "tok",
              expirationPolicy: "ttl:30d",
            },
          }),
        }),
      );
      const opts = await fetchSnapshotsUploadOptions("my-org", "my-project");
      expect(opts.objectstore.url).toBe("https://os.example.com");
      expect(opts.objectstore.usecase).toBe(expectedUsecase);
      const [region, endpoint, options] =
        apiRequestToRegionMock.mock.calls.at(-1) ?? [];
      expect(region).toBe("https://us.sentry.io");
      expect(endpoint).toBe(
        "projects/my-org/my-project/preprodartifacts/snapshots/upload-options/",
      );
      expect(options.params).toEqual({ usecase: "auto" });
    },
  );

  test("createPreprodSnapshot POSTs the zstd-compressed manifest and parses the response", async () => {
    sdkFetchMock.mockReset();
    sdkFetchMock.mockResolvedValue(
      Response.json({
        artifactId: "snap-1",
        snapshotMetricsId: "200",
        imageCount: 3,
        snapshotUrl: "https://s",
      }),
    );
    const manifest = {
      app_id: "app",
      images: { "a.png": { content_hash: "abc", width: 1, height: 2 } },
    };
    const res = await createPreprodSnapshot("my-org", "my-project", manifest);
    expect(res.artifactId).toBe("snap-1");
    expect(res.imageCount).toBe(3);
    const request = sdkFetchMock.mock.calls.at(-1)?.[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      "https://us.sentry.io/api/0/projects/my-org/my-project/preprodartifacts/snapshots/",
    );
    expect(request?.headers.get("Content-Encoding")).toBe("zstd");
    expect(request?.headers.get("Content-Type")).toBe("application/json");
    await expect(lastSdkRequestBody()).resolves.toEqual(manifest);
  });

  test("getLatestBaseSnapshot maps the response and forwards params", async () => {
    sdkFetchMock.mockReset();
    sdkFetchMock.mockResolvedValue(
      Response.json({ head_artifact_id: "art-1", image_count: 5 }),
    );

    await expect(
      getLatestBaseSnapshot("my-org", "my-app", {
        branch: "main",
        project: "proj-1",
      }),
    ).resolves.toEqual({ headArtifactId: "art-1", imageCount: 5 });
    // app_id + optional branch/project go through as query params.
    const url = new URL(sdkFetchMock.mock.calls.at(-1)?.[0].url ?? "");
    expect(url.pathname).toBe(
      "/api/0/organizations/my-org/preprodartifacts/snapshots/latest-base/",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_id: "my-app",
      branch: "main",
      project: "proj-1",
    });
  });

  test("getLatestBaseSnapshot returns null for a null body", async () => {
    sdkFetchMock.mockReset();
    sdkFetchMock.mockResolvedValue(Response.json(null));
    await expect(getLatestBaseSnapshot("my-org", "my-app")).resolves.toBeNull();
  });

  test("getLatestBaseSnapshot returns null on 404", async () => {
    sdkFetchMock.mockReset();
    sdkFetchMock.mockResolvedValue(
      Response.json({ detail: "Not found" }, { status: 404 }),
    );
    await expect(
      getLatestBaseSnapshot("my-org", "missing"),
    ).resolves.toBeNull();
  });

  test("getLatestBaseSnapshot rethrows other HTTP errors", async () => {
    sdkFetchMock.mockReset();
    sdkFetchMock.mockResolvedValue(
      Response.json({ detail: "Boom" }, { status: 500 }),
    );
    const error = await getLatestBaseSnapshot("my-org", "my-app").catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
  });

  test("waitForSnapshotArchive triggers a build then resolves when ready", async () => {
    sdkFetchMock.mockReset();
    sdkFetchMock
      .mockResolvedValueOnce(Response.json({ ready: false }))
      .mockResolvedValueOnce(
        Response.json(
          { detail: "Building your snapshot archive" },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ready: true }));
    const onBuild = vi.fn();

    await waitForSnapshotArchive("my-org", "snap 1", onBuild);

    const requests = sdkFetchMock.mock.calls.map(([request]) => [
      request.method,
      request.url,
    ]);
    const url =
      "https://us.sentry.io/api/0/organizations/my-org/preprodartifacts/snapshots/snap%201/archive/";
    expect(requests).toEqual([
      ["GET", url],
      ["POST", url],
      ["GET", url],
    ]);
    expect(onBuild).toHaveBeenCalledTimes(1);
  });

  test("waitForSnapshotArchive skips the build when already ready", async () => {
    sdkFetchMock.mockReset();
    sdkFetchMock.mockResolvedValue(Response.json({ ready: true }));
    const onBuild = vi.fn();

    await waitForSnapshotArchive("my-org", "snap-1", onBuild);

    expect(sdkFetchMock).toHaveBeenCalledTimes(1);
    expect(sdkFetchMock.mock.calls[0]?.[0].method).toBe("GET");
    expect(onBuild).not.toHaveBeenCalled();
  });

  test("waitForSnapshotArchive surfaces a failed build start", async () => {
    sdkFetchMock.mockReset();
    sdkFetchMock
      .mockResolvedValueOnce(Response.json({ ready: false }))
      .mockResolvedValueOnce(
        Response.json({ detail: "Try again later" }, { status: 503 }),
      );

    const error = await waitForSnapshotArchive("my-org", "snap-1").catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
  });

  test("openSnapshotArchive returns the response for streaming", async () => {
    const response = { ok: true, status: 200, body: {} };
    customFetchMock.mockResolvedValue(response);

    await expect(openSnapshotArchive("my-org", "snap-1")).resolves.toBe(
      response,
    );
    // Auth token attached; URL targets the region archive endpoint.
    const [url, init] = customFetchMock.mock.calls.at(-1) ?? [];
    expect(url).toContain(
      "/preprodartifacts/snapshots/snap-1/archive/?download",
    );
    expect(init?.headers?.Authorization).toBe("Bearer secret-token");
  });

  test("openSnapshotArchive throws on a non-2xx response", async () => {
    customFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
    });
    await expect(openSnapshotArchive("my-org", "snap-1")).rejects.toThrow(
      ApiError,
    );
  });
});
