/**
 * Tests for `sentry react-native gradle`.
 *
 * Drives the command via `loader()`. Org/project resolution and the sourcemap
 * upload are spied; debug-ID injection runs for real against temp fixtures.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { gradleCommand } from "../../../src/commands/react-native/gradle.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as sourcemaps from "../../../src/lib/api/sourcemaps.js";
import { ValidationError } from "../../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

let tmpDir: string;
let bundle: string;
let sourcemap: string;

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
  };
}

describe("react-native gradle", () => {
  let uploadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "rn-gradle-"));
    bundle = join(tmpDir, "index.android.bundle");
    sourcemap = join(tmpDir, "index.android.bundle.map");
    await writeFile(bundle, 'console.log("hello");\n');
    await writeFile(
      sourcemap,
      JSON.stringify({
        version: 3,
        sources: ["index.js"],
        names: [],
        mappings: "",
        sourcesContent: ["console.log('hello');"],
      })
    );
    vi.spyOn(resolveTarget, "resolveOrgAndProject").mockResolvedValue({
      org: "acme",
      project: "mobile",
    });
    uploadSpy = vi
      .spyOn(sourcemaps, "uploadSourcemaps")
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("injects a debug id and uploads once (debug-id only)", async () => {
    const func = await gradleCommand.loader();
    await func.call(createContext().context, { bundle, sourcemap });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const opts = uploadSpy.mock.calls[0][0] as sourcemaps.UploadOptions;
    expect(opts.org).toBe("acme");
    expect(opts.project).toBe("mobile");
    expect(opts.release).toBeUndefined();
    expect(opts.files.map((f) => f.url)).toEqual([
      "~/index.android.bundle",
      "~/index.android.bundle.map",
    ]);
    expect(opts.files[0]).toMatchObject({
      type: "minified_source",
      sourcemapFilename: "index.android.bundle.map",
    });
    expect(opts.files[0].debugId).toMatch(/[0-9a-f-]{36}/);
    // The bundle on disk now carries the injected debug id.
    expect(await readFile(bundle, "utf8")).toContain("debugId");
  });

  test("uploads once per distribution when a release is given", async () => {
    const func = await gradleCommand.loader();
    await func.call(createContext().context, {
      bundle,
      sourcemap,
      release: "1.0.0",
      dist: ["1000", "1001"],
    });

    expect(uploadSpy).toHaveBeenCalledTimes(2);
    const dists = uploadSpy.mock.calls.map(
      (c) => (c[0] as sourcemaps.UploadOptions).dist
    );
    expect(dists).toEqual(["1000", "1001"]);
    for (const call of uploadSpy.mock.calls) {
      expect((call[0] as sourcemaps.UploadOptions).release).toBe("1.0.0");
    }
  });

  test("threads --wait / --wait-for into the upload", async () => {
    const func = await gradleCommand.loader();

    await func.call(createContext().context, { bundle, sourcemap });
    expect(uploadSpy.mock.calls[0][0]).toMatchObject({ wait: false });

    await func.call(createContext().context, { bundle, sourcemap, wait: true });
    expect(uploadSpy.mock.calls[1][0]).toMatchObject({ wait: true });

    await func.call(createContext().context, {
      bundle,
      sourcemap,
      "wait-for": 30,
    });
    expect(uploadSpy.mock.calls[2][0]).toMatchObject({
      wait: true,
      maxWaitMs: 30_000,
    });
  });

  test("rejects a missing bundle", async () => {
    const func = await gradleCommand.loader();
    await expect(
      func.call(createContext().context, {
        bundle: join(tmpDir, "nope.bundle"),
        sourcemap,
      })
    ).rejects.toThrow(ValidationError);
  });

  test("rejects an indexed RAM bundle", async () => {
    await writeFile(bundle, Buffer.from([0xe5, 0xd1, 0x0b, 0xfb, 0x00, 0x00]));
    const func = await gradleCommand.loader();
    await expect(
      func.call(createContext().context, { bundle, sourcemap })
    ).rejects.toThrow(/RAM bundle/);
  });
});
