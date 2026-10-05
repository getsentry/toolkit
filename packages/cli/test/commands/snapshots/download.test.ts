/**
 * Tests for `sentry snapshots download`.
 *
 * Drives the command via its wrapper `loader()`. Org resolution and the
 * snapshot API are spied; extraction runs for real against an in-memory ZIP
 * built with fflate, writing into a temp output directory.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { downloadCommand } from "../../../src/commands/snapshots/download.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as preprod from "../../../src/lib/api/preprod-artifacts.js";
import { ContextError, ValidationError } from "../../../src/lib/errors.js";
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
  };
}

function snapshotZip(): Buffer {
  return Buffer.from(
    zipSync({ "img1.png": strToU8("A"), "img2.png": strToU8("B") })
  );
}

/** Yield a buffer as a chunked async stream (a fresh generator per call). */
async function* streamOf(buffer: Uint8Array): AsyncIterable<Uint8Array> {
  const chunkSize = 8;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    yield buffer.subarray(offset, offset + chunkSize);
  }
}

describe("snapshots download", () => {
  let downloadSpy: ReturnType<typeof vi.spyOn>;
  let latestSpy: ReturnType<typeof vi.spyOn>;
  let waitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "snap-dl-"));
    vi.spyOn(resolveTarget, "resolveOrg").mockResolvedValue({
      org: "test-org",
    });
    waitSpy = vi
      .spyOn(preprod, "waitForSnapshotArchive")
      .mockResolvedValue(undefined);
    // Fresh streamable body per call (an async generator is single-use).
    downloadSpy = vi
      .spyOn(preprod, "openSnapshotArchive")
      .mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: streamOf(snapshotZip()),
        } as unknown as Response)
      );
    latestSpy = vi.spyOn(preprod, "getLatestBaseSnapshot").mockResolvedValue({
      headArtifactId: "resolved-art",
      imageCount: 2,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("downloads a snapshot by --snapshot-id and extracts images", async () => {
    const out = join(tmpDir, "base");
    const harness = createContext();
    const func = await downloadCommand.loader();

    await func.call(harness.context, {
      "snapshot-id": "snap-1",
      output: out,
    });

    expect(waitSpy).toHaveBeenCalledWith(
      "test-org",
      "snap-1",
      expect.any(Function)
    );
    expect(downloadSpy).toHaveBeenCalledWith("test-org", "snap-1");
    expect(latestSpy).not.toHaveBeenCalled();
    expect(harness.output()).toContain("snap-1");
    expect(harness.output()).toContain("2");
  });

  test("resolves the latest baseline by --app-id", async () => {
    const harness = createContext();
    const func = await downloadCommand.loader();

    await func.call(harness.context, {
      "app-id": "my-app",
      branch: "main",
      output: join(tmpDir, "base"),
    });

    expect(latestSpy).toHaveBeenCalledWith("test-org", "my-app", {
      branch: "main",
      project: undefined,
    });
    expect(downloadSpy).toHaveBeenCalledWith("test-org", "resolved-art");
  });

  test("rejects when both --app-id and --snapshot-id are given", async () => {
    const func = await downloadCommand.loader();
    await expect(
      func.call(createContext().context, {
        "app-id": "a",
        "snapshot-id": "s",
      })
    ).rejects.toThrow(ValidationError);
  });

  test("rejects when neither --app-id nor --snapshot-id is given", async () => {
    const func = await downloadCommand.loader();
    await expect(func.call(createContext().context, {})).rejects.toThrow(
      ContextError
    );
  });

  test("rejects --branch without --app-id", async () => {
    const func = await downloadCommand.loader();
    await expect(
      func.call(createContext().context, {
        "snapshot-id": "s",
        branch: "main",
      })
    ).rejects.toThrow(ValidationError);
  });
});
