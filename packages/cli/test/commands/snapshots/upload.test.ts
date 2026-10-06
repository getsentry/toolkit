/**
 * Tests for `sentry snapshots upload`.
 *
 * Drives the command via its wrapper `loader()`. Org/project resolution, the
 * upload-options + create-snapshot API, and the objectstore HEAD/PUT primitives
 * are spied; image collection runs for real against PNG fixtures in a temp dir.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { uploadCommand } from "../../../src/commands/snapshots/upload.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as preprod from "../../../src/lib/api/preprod-artifacts.js";
import { ValidationError } from "../../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as objectstore from "../../../src/lib/objectstore.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

let tmpDir: string;

function createContext() {
  const writes: string[] = [];
  return {
    context: {
      stdout: {
        write: (data: string | Uint8Array) => {
          writes.push(
            typeof data === "string" ? data : new TextDecoder().decode(data)
          );
          return true;
        },
      },
      stderr: { write: () => true },
      cwd: tmpDir,
      env: {} as NodeJS.ProcessEnv,
      process: { ...process, exitCode: undefined } as typeof process,
    },
    output: () => writes.join(""),
    get exitCode() {
      return this.context.process.exitCode;
    },
  };
}

function pngBytes(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0xff);
  return PNG.sync.write(png);
}

const UPLOAD_OPTIONS = {
  objectstore: {
    url: "https://os.example.com",
    usecase: "preprod_snapshots",
    scopes: [
      ["org", "1"],
      ["project", "2"],
    ] as [string, string][],
    authToken: "tok",
    expirationPolicy: "ttl:30d",
  },
};

describe("snapshots upload", () => {
  let existsSpy: ReturnType<typeof vi.spyOn>;
  let putSpy: ReturnType<typeof vi.spyOn>;
  let createSpy: ReturnType<typeof vi.spyOn>;
  let uploadOptionsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "snap-up-"));
    vi.spyOn(resolveTarget, "resolveOrgAndProject").mockResolvedValue({
      org: "test-org",
      project: "test-project",
    });
    uploadOptionsSpy = vi
      .spyOn(preprod, "fetchSnapshotsUploadOptions")
      .mockResolvedValue(UPLOAD_OPTIONS);
    existsSpy = vi.spyOn(objectstore, "objectExists").mockResolvedValue(false);
    putSpy = vi.spyOn(objectstore, "putObject").mockResolvedValue(undefined);
    createSpy = vi.spyOn(preprod, "createPreprodSnapshot").mockResolvedValue({
      artifactId: "snap-1",
      imageCount: 2,
      snapshotUrl: "https://sentry.io/snap-1",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Write a folder with two PNGs (one nested) + a sidecar; returns its path. */
  async function writeShots(): Promise<string> {
    const dir = join(tmpDir, "shots");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.png"), pngBytes(4, 3));
    await writeFile(join(dir, "a.json"), JSON.stringify({ note: "hi" }));
    await writeFile(join(dir, "sub", "b.png"), pngBytes(2, 2));
    return dir;
  }

  test.each([
    "preprod",
    "preprod_snapshots",
  ])("uploads images to %s and creates a snapshot with a correct manifest", async (usecase) => {
    const config = { ...UPLOAD_OPTIONS.objectstore, usecase };
    uploadOptionsSpy.mockResolvedValue({ objectstore: config });
    const dir = await writeShots();
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, { "app-id": "com.example.app" }, dir);

    // Two images uploaded (none pre-existing).
    expect(putSpy).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenCalledTimes(1);

    const [, , manifest] = createSpy.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(manifest.app_id).toBe("com.example.app");
    const images = manifest.images as Record<string, Record<string, unknown>>;
    expect(Object.keys(images).sort()).toEqual(["a.png", "sub/b.png"]);
    expect(images["a.png"]).toMatchObject({
      width: 4,
      height: 3,
      note: "hi",
    });
    expect(images["a.png"].content_hash).toMatch(/^[0-9a-f]{64}$/);
    // selective omitted when not requested.
    expect(manifest.selective).toBeUndefined();
    expect(harness.output()).toContain("snap-1");

    // The objectstore key is `{orgId}/{projectId}/{sha256}` from the scope.
    const hash = images["a.png"].content_hash as string;
    const key = putSpy.mock.calls.find(([, k]) =>
      (k as string).endsWith(hash)
    )?.[1] as string;
    expect(key).toMatch(/^1\/2\/[0-9a-f]{64}$/);
    expect(key.endsWith(hash)).toBe(true);
    expect(existsSpy).toHaveBeenCalledWith(config, key);
    expect(putSpy).toHaveBeenCalledWith(config, key, expect.any(Uint8Array));
  });

  test("CLI width/height/content_hash override sidecar keys", async () => {
    const dir = join(tmpDir, "shots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.png"), pngBytes(4, 3));
    await writeFile(
      join(dir, "a.json"),
      JSON.stringify({ width: 999, height: 888, content_hash: "nope", keep: 1 })
    );
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, { "app-id": "app" }, dir);

    const [, , manifest] = createSpy.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    const entry = (manifest.images as Record<string, Record<string, unknown>>)[
      "a.png"
    ];
    expect(entry.width).toBe(4);
    expect(entry.height).toBe(3);
    expect(entry.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.keep).toBe(1);
  });

  test("rejects --pr-number without a resolvable base SHA", async () => {
    const dir = await writeShots();
    const func = await uploadCommand.loader();
    await expect(
      func.call(
        createContext().context,
        { "app-id": "app", "pr-number": 7 },
        dir
      )
    ).rejects.toThrow(ValidationError);
  });

  test("resolves a relative folder path against the command cwd", async () => {
    await writeShots(); // creates <cwd>/shots
    const harness = createContext(); // cwd === tmpDir
    const func = await uploadCommand.loader();

    await func.call(harness.context, { "app-id": "app" }, "shots");

    expect(putSpy).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  test("skips objects already present in objectstore", async () => {
    const dir = await writeShots();
    // First image already exists, second does not.
    existsSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, { "app-id": "app" }, dir);

    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  test("reports no images and creates nothing for an empty folder", async () => {
    const dir = join(tmpDir, "empty");
    await mkdir(dir);
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, { "app-id": "app" }, dir);

    expect(createSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
    expect(harness.output()).toContain("No image files found");
  });

  test("creates an all-unchanged snapshot from an inline image-name list", async () => {
    const dir = join(tmpDir, "empty");
    await mkdir(dir);
    createSpy.mockResolvedValue({
      artifactId: "snap-empty",
      imageCount: 0,
      snapshotUrl: "https://sentry.io/snap-empty",
    });
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(
      harness.context,
      {
        "app-id": "app",
        "all-image-file-names": "./a.png,sub\\b.jpg",
      },
      dir
    );

    expect(uploadOptionsSpy).not.toHaveBeenCalled();
    expect(existsSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const manifest = createSpy.mock.calls[0]?.[2];
    expect(manifest).toMatchObject({
      app_id: "app",
      selective: true,
      all_image_file_names: ["a.png", "sub/b.jpg"],
    });
    expect(manifest?.images).toEqual({});
    expect(harness.output()).toContain("snap-empty");
  });

  test("creates an all-unchanged snapshot from an image-name file", async () => {
    const dir = join(tmpDir, "empty");
    const namesFile = join(tmpDir, "all-images.txt");
    await mkdir(dir);
    await writeFile(namesFile, "a.png\nsub/b.png\n");
    createSpy.mockResolvedValue({
      artifactId: "snap-empty",
      imageCount: 0,
      snapshotUrl: null,
    });
    const func = await uploadCommand.loader();

    await func.call(
      createContext().context,
      { "app-id": "app", "all-image-file-names-file": namesFile },
      dir
    );

    expect(uploadOptionsSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const manifest = createSpy.mock.calls[0]?.[2];
    expect(manifest).toMatchObject({
      selective: true,
      all_image_file_names: ["a.png", "sub/b.png"],
    });
    expect(manifest?.images).toEqual({});
  });

  test("keeps an empty --selective-only upload as a no-op", async () => {
    const dir = join(tmpDir, "empty");
    await mkdir(dir);
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, { "app-id": "app", selective: true }, dir);

    expect(createSpy).not.toHaveBeenCalled();
    expect(uploadOptionsSpy).not.toHaveBeenCalled();
    expect(harness.output()).toContain("No image files found");
  });

  test("rejects an unreadable image-name file for an empty upload", async () => {
    const dir = join(tmpDir, "empty");
    await mkdir(dir);
    const func = await uploadCommand.loader();

    await expect(
      func.call(
        createContext().context,
        {
          "app-id": "app",
          "all-image-file-names-file": join(tmpDir, "missing.txt"),
        },
        dir
      )
    ).rejects.toThrow(ValidationError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("rejects an empty image-name list for an empty upload", async () => {
    const dir = join(tmpDir, "empty");
    const namesFile = join(tmpDir, "all-images.txt");
    await mkdir(dir);
    await writeFile(namesFile, " \n\n");
    const func = await uploadCommand.loader();

    await expect(
      func.call(
        createContext().context,
        { "app-id": "app", "all-image-file-names-file": namesFile },
        dir
      )
    ).rejects.toThrow(ValidationError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test.each([
    { "all-image-file-names": "" },
    { "all-image-file-names-file": "" },
  ])("rejects an explicitly empty image-name flag", async (flag) => {
    const dir = join(tmpDir, "empty");
    await mkdir(dir);
    const func = await uploadCommand.loader();

    await expect(
      func.call(createContext().context, { "app-id": "app", ...flag }, dir)
    ).rejects.toThrow(ValidationError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("rejects a path that is not a directory", async () => {
    const file = join(tmpDir, "a.png");
    await writeFile(file, pngBytes(1, 1));
    const func = await uploadCommand.loader();
    await expect(
      func.call(createContext().context, { "app-id": "app" }, file)
    ).rejects.toThrow(ValidationError);
  });

  test("marks selective + rejects images missing from --all-image-file-names", async () => {
    const dir = await writeShots();
    const func = await uploadCommand.loader();
    await expect(
      func.call(
        createContext().context,
        { "app-id": "app", "all-image-file-names": "a.png" },
        dir
      )
    ).rejects.toThrow(ValidationError);
  });

  test("passes diff-threshold and selective into the manifest", async () => {
    const dir = await writeShots();
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(
      harness.context,
      { "app-id": "app", "diff-threshold": 0.05, selective: true },
      dir
    );

    const [, , manifest] = createSpy.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(manifest.diff_threshold).toBe(0.05);
    expect(manifest.selective).toBe(true);
  });
});
