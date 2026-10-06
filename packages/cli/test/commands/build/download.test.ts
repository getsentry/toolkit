/**
 * Tests for `sentry build download`.
 *
 * Drives the command through its wrapper `loader()` and spies on the
 * preprod-artifacts API + org/region resolution, so the orchestration
 * (URL rewrite, format inference, default output path, not-installable guard)
 * is exercised without a network.
 */

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { downloadCommand } from "../../../src/commands/build/download.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as preprod from "../../../src/lib/api/preprod-artifacts.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as region from "../../../src/lib/region.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

let tmpDir: string;

/** Minimal SentryContext with stdout capture and cwd pinned to the temp dir. */
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
    },
    output: () => writes.join(""),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("build download", () => {
  let installSpy: ReturnType<typeof vi.spyOn>;
  let downloadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "build-download-"));
    vi.spyOn(resolveTarget, "resolveOrg").mockResolvedValue({ org: "test-org" });
    vi.spyOn(region, "resolveOrgRegion").mockResolvedValue(
      "https://us.sentry.io"
    );
    installSpy = vi.spyOn(preprod, "getBuildInstallDetails");
    downloadSpy = vi
      .spyOn(preprod, "downloadBuildArtifact")
      .mockImplementation(async (_region, _url, dest) => {
        await writeFile(dest, "FAKE-BINARY");
      });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("downloads an ipa to the default path (rewriting plist → ipa)", async () => {
    installSpy.mockResolvedValue({
      isInstallable: true,
      installUrl: "https://us.sentry.io/dl/?response_format=plist",
    });
    const { context, output } = createContext();
    const func = await downloadCommand.loader();

    await func.call(context, { output: undefined }, "build-1");

    expect(installSpy).toHaveBeenCalledWith("test-org", "build-1");
    // The plist manifest URL is rewritten to fetch the ipa binary.
    expect(downloadSpy.mock.calls.at(-1)?.[1]).toContain("response_format=ipa");
    const dest = join(tmpDir, "preprod_artifact_build-1.ipa");
    expect(await exists(dest)).toBe(true);
    expect(await readFile(dest, "utf8")).toBe("FAKE-BINARY");
    expect(output()).toContain("build-1");
    expect(output()).toContain("ipa");
  });

  test("writes to a custom --output path", async () => {
    installSpy.mockResolvedValue({
      isInstallable: true,
      installUrl: "https://us.sentry.io/dl/?response_format=apk",
    });
    const outPath = join(tmpDir, "custom.apk");
    const { context } = createContext();
    const func = await downloadCommand.loader();

    await func.call(context, { output: outPath }, "b2");

    expect(await exists(outPath)).toBe(true);
    expect(await exists(join(tmpDir, "preprod_artifact_b2.apk"))).toBe(false);
  });

  test("rejects a non-installable build without downloading", async () => {
    installSpy.mockResolvedValue({ isInstallable: false, installUrl: null });
    const { context } = createContext();
    const func = await downloadCommand.loader();

    await expect(
      func.call(context, { output: undefined }, "b3")
    ).rejects.toThrow(/not installable/i);
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});
