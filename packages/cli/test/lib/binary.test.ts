/**
 * Binary Management Tests
 *
 * Tests for shared binary helpers: install directory selection, paths,
 * download URLs, locking, and binary installation.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  acquireLock,
  compareVersions,
  determineInstallDir,
  fetchWithUpgradeError,
  getBinaryDownloadUrl,
  getBinaryFilename,
  getBinaryPaths,
  getGitHubReleaseByTagUrl,
  getLegacyInstallDirs,
  getPlatformBinaryName,
  installBinary,
  isDowngrade,
  isMusl,
  parseUpgradeJson,
  releaseLock,
  replaceBinarySync,
  resolveUpgradeSource,
  samePath,
  UPGRADE_SOURCES,
  UpgradeSourceNotFoundError,
} from "../../src/lib/binary.js";
import { UpgradeError } from "../../src/lib/errors.js";

describe("getBinaryDownloadUrl", () => {
  test("builds correct URL for current platform", () => {
    const url = getBinaryDownloadUrl("1.0.0");

    expect(url).toContain("/cli@1.0.0/");
    expect(url).toStartWith(
      "https://github.com/getsentry/toolkit/releases/download/"
    );
    expect(url).toContain("sentry-");

    const arch = process.arch === "arm64" ? "arm64" : "x64";
    expect(url).toContain(arch);
  });

  test("includes .exe suffix on Windows", () => {
    // Can only truly test this on Windows, but we verify the format
    const url = getBinaryDownloadUrl("2.0.0");
    if (process.platform === "win32") {
      expect(url).toEndWith(".exe");
    } else {
      expect(url).not.toEndWith(".exe");
    }
  });
});

describe("UPGRADE_SOURCES", () => {
  test("checks Toolkit before the legacy CLI repository", () => {
    expect(UPGRADE_SOURCES).toEqual([
      {
        githubRepo: "getsentry/toolkit",
        ghcrRepo: "getsentry/toolkit",
        tagPrefix: "cli@",
      },
      {
        githubRepo: "getsentry/cli",
        ghcrRepo: "getsentry/cli",
        tagPrefix: "",
      },
    ]);
  });
});

describe("resolveUpgradeSource", () => {
  test("uses the first source when it exists", async () => {
    const requests: string[] = [];

    const resolved = await resolveUpgradeSource({
      getProbeUrl: (source) => getGitHubReleaseByTagUrl("0.45.0", source),
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ tag_name: "cli@0.45.0" }), {
          status: 200,
        });
      },
    });

    expect(resolved).toEqual({
      source: UPGRADE_SOURCES[0],
      response: expect.any(Response),
    });
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%400.45.0",
    ]);
  });

  test("falls back to the legacy source only on HTTP 404", async () => {
    const requests: string[] = [];

    const resolved = await resolveUpgradeSource({
      getProbeUrl: (source) => getGitHubReleaseByTagUrl("0.45.0", source),
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(
          requests.length === 1
            ? "Not Found"
            : JSON.stringify({ tag_name: "0.45.0" }),
          { status: requests.length === 1 ? 404 : 200 }
        );
      },
    });

    expect(resolved.source).toBe(UPGRADE_SOURCES[1]);
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%400.45.0",
      "https://api.github.com/repos/getsentry/cli/releases/tags/0.45.0",
    ]);
  });

  test.each([
    401, 403, 429, 500,
  ])("does not fall back on HTTP %i", async (status) => {
    const requests: string[] = [];

    await expect(
      resolveUpgradeSource({
        getProbeUrl: (source) => getGitHubReleaseByTagUrl("0.45.0", source),
        fetch: async (url) => {
          requests.push(String(url));
          return new Response("failure", { status });
        },
      })
    ).rejects.toThrow(`HTTP ${status}`);

    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%400.45.0",
    ]);
  });

  test("does not fall back on a network failure", async () => {
    const requests: string[] = [];

    await expect(
      resolveUpgradeSource({
        getProbeUrl: (source) => getGitHubReleaseByTagUrl("0.45.0", source),
        fetch: async (url) => {
          requests.push(String(url));
          throw new TypeError("fetch failed");
        },
      })
    ).rejects.toThrow("Failed to connect to GitHub: fetch failed");

    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%400.45.0",
    ]);
  });

  test("fails after every source returns 404", async () => {
    const requests: string[] = [];

    const error = await resolveUpgradeSource({
      getProbeUrl: (source) => getGitHubReleaseByTagUrl("0.45.0", source),
      fetch: async (url) => {
        requests.push(String(url));
        return new Response("Not Found", { status: 404 });
      },
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(UpgradeSourceNotFoundError);
    expect(error).toMatchObject({ name: "UpgradeSourceNotFoundError" });

    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%400.45.0",
      "https://api.github.com/repos/getsentry/cli/releases/tags/0.45.0",
    ]);
  });
});

describe("getBinaryFilename", () => {
  test("returns sentry on non-Windows", () => {
    if (process.platform !== "win32") {
      expect(getBinaryFilename()).toBe("sentry");
    }
  });
});

describe("getBinaryPaths", () => {
  test("returns all derived paths from install path", () => {
    const paths = getBinaryPaths("/usr/local/bin/sentry");

    expect(paths.installPath).toBe("/usr/local/bin/sentry");
    expect(paths.tempPath).toBe("/usr/local/bin/sentry.download");
    expect(paths.oldPath).toBe("/usr/local/bin/sentry.old");
    expect(paths.lockPath).toBe("/usr/local/bin/sentry.lock");
  });
});

describe("samePath", () => {
  test("matches identical paths", () => {
    expect(samePath("/home/user/.local/bin", "/home/user/.local/bin")).toBe(
      true
    );
  });

  test("distinguishes genuinely different paths", () => {
    expect(samePath("/home/user/.local/bin", "/home/user/.sentry/bin")).toBe(
      false
    );
  });

  test("case sensitivity follows the platform", () => {
    const result = samePath("/Home/User/bin", "/home/user/bin");
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(result).toBe(true);
    } else {
      expect(result).toBe(false);
    }
  });

  test("tolerates a trailing separator on either side", () => {
    const dir = join("/home/user", ".local", "bin");
    expect(samePath(dir + sep, dir)).toBe(true);
    expect(samePath(dir, dir + sep)).toBe(true);
    expect(samePath(dir + sep, dir + sep)).toBe(true);
  });

  test("does not treat root as equal to empty after stripping", () => {
    // A bare root separator must not be stripped to "".
    expect(samePath(sep, sep)).toBe(true);
    expect(samePath(sep, "")).toBe(false);
  });
});

describe("getLegacyInstallDirs", () => {
  test("returns only the pre-XDG ~/.sentry/bin, not current XDG targets", () => {
    const dirs = getLegacyInstallDirs("/home/user");
    expect(dirs).toEqual([join("/home/user", ".sentry", "bin")]);
    // ~/.local/bin and ~/bin are valid current targets, never migration sources
    expect(dirs).not.toContain(join("/home/user", ".local", "bin"));
    expect(dirs).not.toContain(join("/home/user", "bin"));
  });
});

describe("determineInstallDir", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      "/tmp",
      `binary-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("uses SENTRY_INSTALL_DIR when set", () => {
    const customDir = join(testDir, "custom");
    mkdirSync(customDir, { recursive: true });

    const result = determineInstallDir(testDir, {
      SENTRY_INSTALL_DIR: customDir,
      PATH: "/usr/bin",
    });

    expect(result).toBe(customDir);
  });

  test("prefers ~/.local/bin when it exists and is in PATH", () => {
    const localBin = join(testDir, ".local", "bin");
    mkdirSync(localBin, { recursive: true });

    const result = determineInstallDir(testDir, {
      PATH: `/usr/bin:${localBin}`,
    });

    expect(result).toBe(localBin);
  });

  test("matches a PATH entry case-insensitively on Windows/macOS", () => {
    // Use ~/bin so the result is distinguishable from the ~/.local/bin fallback.
    const homeBin = join(testDir, "bin");
    mkdirSync(homeBin, { recursive: true });

    const result = determineInstallDir(testDir, {
      PATH: `/usr/bin:${homeBin.toUpperCase()}`,
    });

    if (process.platform === "win32" || process.platform === "darwin") {
      // Case-insensitive FS: the upper-cased PATH entry still matches ~/bin.
      expect(result).toBe(homeBin);
    } else {
      // Case-sensitive FS: no match, so it falls back to the XDG default.
      expect(result).toBe(join(testDir, ".local", "bin"));
    }
  });

  test("uses ~/bin when it exists and is in PATH but ~/.local/bin is not", () => {
    const homeBin = join(testDir, "bin");
    mkdirSync(homeBin, { recursive: true });

    const result = determineInstallDir(testDir, {
      PATH: `/usr/bin:${homeBin}`,
    });

    expect(result).toBe(homeBin);
  });

  test("falls back to ~/.local/bin when no candidates are in PATH", () => {
    const result = determineInstallDir(testDir, {
      PATH: "/usr/bin:/bin",
    });

    expect(result).toBe(join(testDir, ".local", "bin"));
  });

  test("falls back to ~/.local/bin when it exists but is not in PATH", () => {
    const localBin = join(testDir, ".local", "bin");
    mkdirSync(localBin, { recursive: true });

    const result = determineInstallDir(testDir, {
      PATH: "/usr/bin:/bin",
    });

    expect(result).toBe(localBin);
  });

  test("handles empty PATH", () => {
    const result = determineInstallDir(testDir, {
      PATH: "",
    });

    expect(result).toBe(join(testDir, ".local", "bin"));
  });

  test("handles undefined PATH", () => {
    const result = determineInstallDir(testDir, {});

    expect(result).toBe(join(testDir, ".local", "bin"));
  });

  test("uses XDG_BIN_HOME when set to an absolute path", () => {
    const xdgBin = join(testDir, "xdg", "bin");

    const result = determineInstallDir(testDir, {
      XDG_BIN_HOME: xdgBin,
      PATH: "/usr/bin",
    });

    expect(result).toBe(xdgBin);
  });

  test("ignores a non-absolute XDG_BIN_HOME per the XDG spec", () => {
    const result = determineInstallDir(testDir, {
      XDG_BIN_HOME: "relative/bin",
      PATH: "/usr/bin",
    });

    expect(result).toBe(join(testDir, ".local", "bin"));
  });

  test("XDG_BIN_HOME takes priority over ~/.local/bin in PATH", () => {
    const localBin = join(testDir, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const xdgBin = join(testDir, "xdg", "bin");

    const result = determineInstallDir(testDir, {
      XDG_BIN_HOME: xdgBin,
      PATH: `/usr/bin:${localBin}`,
    });

    expect(result).toBe(xdgBin);
  });

  test("SENTRY_INSTALL_DIR takes priority over XDG_BIN_HOME", () => {
    const xdgBin = join(testDir, "xdg", "bin");
    const customDir = join(testDir, "custom");
    mkdirSync(customDir, { recursive: true });

    const result = determineInstallDir(testDir, {
      SENTRY_INSTALL_DIR: customDir,
      XDG_BIN_HOME: xdgBin,
      PATH: "/usr/bin",
    });

    expect(result).toBe(customDir);
  });

  test("SENTRY_INSTALL_DIR takes priority over ~/.local/bin", () => {
    const localBin = join(testDir, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const customDir = join(testDir, "custom");
    mkdirSync(customDir, { recursive: true });

    const result = determineInstallDir(testDir, {
      SENTRY_INSTALL_DIR: customDir,
      PATH: `/usr/bin:${localBin}`,
    });

    expect(result).toBe(customDir);
  });
});

describe("fetchWithUpgradeError", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns response on success", async () => {
    globalThis.fetch = (async () =>
      new Response("ok", { status: 200 })) as typeof globalThis.fetch;

    const response = await fetchWithUpgradeError(
      "https://example.com",
      {},
      "Test"
    );
    expect(response.status).toBe(200);
  });

  test("re-throws AbortError as-is", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof globalThis.fetch;

    try {
      await fetchWithUpgradeError("https://example.com", {}, "Test");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
      expect(error).not.toBeInstanceOf(UpgradeError);
    }
  });

  test("preserves an arbitrary external abort reason", async () => {
    const controller = new AbortController();
    const reason = { kind: "cancelled" };
    const request = resolveUpgradeSource({
      getProbeUrl: () => "https://example.com",
      signal: controller.signal,
      fetch: async () => {
        controller.abort(reason);
        throw reason;
      },
    });

    await expect(request).rejects.toBe(reason);
  });

  test("wraps network errors as UpgradeError", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;

    try {
      await fetchWithUpgradeError("https://example.com", {}, "GitHub");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeError);
      expect((error as UpgradeError).message).toContain("GitHub");
      expect((error as UpgradeError).message).toContain("ECONNREFUSED");
    }
  });

  test("wraps non-Error thrown values as UpgradeError", async () => {
    globalThis.fetch = (async () => {
      // biome-ignore lint/style/useThrowOnlyError: intentionally testing non-Error throw
      throw { code: "ECONNRESET", reason: "connection reset" };
    }) as typeof globalThis.fetch;

    try {
      await fetchWithUpgradeError("https://example.com", {}, "Service");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeError);
      expect((error as UpgradeError).message).toContain("ECONNRESET");
    }
  });
});

describe("parseUpgradeJson", () => {
  test("preserves cancellation during body consumption", async () => {
    const controller = new AbortController();
    const reason = { kind: "cancelled" };
    const response = Response.json({});
    response.json = async () => {
      controller.abort(reason);
      throw new DOMException("aborted", "AbortError");
    };

    await expect(
      parseUpgradeJson(response, controller.signal, "invalid metadata")
    ).rejects.toBe(reason);
  });

  test("classifies body termination as transport failure", async () => {
    const response = Response.json({});
    response.json = async () => {
      throw new TypeError("terminated");
    };

    await expect(
      parseUpgradeJson(response, undefined, "invalid metadata")
    ).rejects.toMatchObject({
      name: "UpgradeTransportError",
      reason: "network_error",
    });
  });

  test("classifies completed malformed JSON as metadata failure", async () => {
    const response = new Response("not json");

    await expect(
      parseUpgradeJson(response, undefined, "invalid metadata")
    ).rejects.toMatchObject({
      name: "UpgradeError",
      reason: "network_error",
      message: "invalid metadata",
    });
  });
});

describe("replaceBinarySync", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      "/tmp",
      `replace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("replaces existing binary atomically on Unix", async () => {
    if (process.platform === "win32") return;

    const installPath = join(testDir, "sentry");
    const tempPath = join(testDir, "sentry.download");

    // Write existing binary
    await writeFile(installPath, "old binary");
    // Write new binary to temp location
    await writeFile(tempPath, "new binary");

    replaceBinarySync(tempPath, installPath);

    // New content should be at install path
    const content = await readFile(installPath, "utf-8");
    expect(content).toBe("new binary");

    // Temp file should no longer exist (it was renamed)
    expect(
      await access(tempPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("works when no existing binary (fresh install)", async () => {
    if (process.platform === "win32") return;

    const installPath = join(testDir, "sentry");
    const tempPath = join(testDir, "sentry.download");

    // Only write temp, no existing binary
    await writeFile(tempPath, "fresh binary");

    replaceBinarySync(tempPath, installPath);

    const content = await readFile(installPath, "utf-8");
    expect(content).toBe("fresh binary");
  });
});

describe("installBinary", () => {
  let testDir: string;
  let sourceDir: string;
  let installDir: string;

  beforeEach(() => {
    testDir = join(
      "/tmp",
      `binary-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    sourceDir = join(testDir, "source");
    installDir = join(testDir, "install");
    mkdirSync(sourceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("copies binary to install directory", async () => {
    const sourcePath = join(sourceDir, "sentry-temp");
    const content = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // ELF magic
    await writeFile(sourcePath, content);
    chmodSync(sourcePath, 0o755);

    const result = await installBinary(sourcePath, installDir);

    expect(result).toBe(join(installDir, getBinaryFilename()));
    expect(
      await access(result).then(
        () => true,
        () => false
      )
    ).toBe(true);

    const installed = await readFile(result);
    expect(new Uint8Array(installed)).toEqual(content);
  });

  test("creates install directory if it does not exist", async () => {
    const sourcePath = join(sourceDir, "sentry-temp");
    await writeFile(sourcePath, "binary content");
    chmodSync(sourcePath, 0o755);

    const nestedDir = join(installDir, "deep", "nested");
    const result = await installBinary(sourcePath, nestedDir);

    expect(result).toBe(join(nestedDir, getBinaryFilename()));
    expect(
      await access(result).then(
        () => true,
        () => false
      )
    ).toBe(true);
  });

  test("cleans up lock file after installation", async () => {
    const sourcePath = join(sourceDir, "sentry-temp");
    await writeFile(sourcePath, "binary content");
    chmodSync(sourcePath, 0o755);

    const installPath = await installBinary(sourcePath, installDir);
    const lockPath = `${installPath}.lock`;

    expect(
      await access(lockPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("cleans up temp .download file after installation", async () => {
    const sourcePath = join(sourceDir, "sentry-temp");
    await writeFile(sourcePath, "binary content");
    chmodSync(sourcePath, 0o755);

    const installPath = await installBinary(sourcePath, installDir);
    const tempPath = `${installPath}.download`;

    expect(
      await access(tempPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("overwrites existing binary", async () => {
    // Install initial binary
    mkdirSync(installDir, { recursive: true });
    const existingPath = join(installDir, getBinaryFilename());
    await writeFile(existingPath, "old content");

    // Install new binary over it
    const sourcePath = join(sourceDir, "sentry-temp");
    await writeFile(sourcePath, "new content");
    chmodSync(sourcePath, 0o755);

    await installBinary(sourcePath, installDir);

    const content = await readFile(existingPath, "utf-8");
    expect(content).toBe("new content");
  });

  test("handles sourcePath === tempPath (upgrade spawn case)", async () => {
    if (process.platform === "win32") return;

    // Simulate the upgrade flow: the source binary IS already the .download file
    // (this happens when upgrade downloads to installPath.download, then spawns
    // setup --install where execPath is that .download file)
    mkdirSync(installDir, { recursive: true });
    const tempPath = join(installDir, `${getBinaryFilename()}.download`);
    await writeFile(tempPath, "upgraded binary");
    chmodSync(tempPath, 0o755);

    const result = await installBinary(tempPath, installDir);

    expect(result).toBe(join(installDir, getBinaryFilename()));
    const content = await readFile(result, "utf-8");
    expect(content).toBe("upgraded binary");
  });

  test("handles sourcePath === tempPath reached through a symlinked install dir", async () => {
    if (process.platform === "win32") return;

    // Reproduces the macOS /tmp -> /private/tmp case: installDir is given via a
    // symlink, but the source binary's path is canonicalized (as process.execPath
    // would be). The two paths point at the same file but differ as strings, so a
    // naive resolve() comparison would unlink the source before copying it.
    const realDir = join(testDir, "real-install");
    mkdirSync(realDir, { recursive: true });
    const symlinkedDir = join(testDir, "symlinked-install");
    symlinkSync(realDir, symlinkedDir);

    // The .download file lives in the real dir; sourcePath uses the canonical path.
    const tempName = `${getBinaryFilename()}.download`;
    const sourcePath = join(realpathSync(realDir), tempName);
    await writeFile(sourcePath, "upgraded binary");
    chmodSync(sourcePath, 0o755);

    // installBinary is called with the symlinked dir, so tempPath resolves to the
    // same file as sourcePath via the symlink.
    const result = await installBinary(sourcePath, symlinkedDir);

    expect(result).toBe(join(symlinkedDir, getBinaryFilename()));
    const content = await readFile(result, "utf-8");
    expect(content).toBe("upgraded binary");
  });
});

describe("acquireLock", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      "/tmp",
      `lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("creates lock file with current PID", () => {
    const lockPath = join(testDir, "test.lock");
    acquireLock(lockPath);

    const content = readFileSync(lockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));

    releaseLock(lockPath);
  });

  test("creates the parent directory if it does not exist", () => {
    // Regression for CLI-1E1 / CLI-1RV: the install dir (e.g. ~/.sentry/bin,
    // or a stale SENTRY_INSTALL_DIR that was later purged) may not exist when
    // the upgrade pipeline tries to acquire the lock. acquireLock must create
    // the parent directory instead of crashing with ENOENT on writeFileSync.
    const missingDir = join(testDir, "nested", "install-dir");
    const lockPath = join(missingDir, "sentry.lock");

    expect(() => acquireLock(lockPath)).not.toThrow();

    const content = readFileSync(lockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));

    releaseLock(lockPath);
  });

  test("propagates the mkdir EEXIST when the parent path is a regular file", () => {
    // Edge case from review: if the lock's parent path is an existing regular
    // file, mkdirSync throws EEXIST. Because mkdir runs OUTSIDE the
    // writeFileSync try/catch, that EEXIST propagates directly. If mkdir were
    // inside the try, the EEXIST would be routed into handleExistingLock,
    // which would then fail reading the lock under a non-directory with a
    // misleading ENOTDIR. Asserting EEXIST therefore guards mkdir's placement.
    const fileAsDir = join(testDir, "not-a-dir");
    writeFileSync(fileAsDir, "i am a file");
    const lockPath = join(fileAsDir, "sentry.lock");

    let caught: NodeJS.ErrnoException | undefined;
    try {
      acquireLock(lockPath);
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("EEXIST");
  });

  test("throws when lock held by another running process", () => {
    const lockPath = join(testDir, "test.lock");
    // PID 1 (init/systemd) is always running
    writeFileSync(lockPath, "1");

    expect(() => acquireLock(lockPath)).toThrow(
      "Another upgrade is already in progress"
    );
  });

  test("takes over stale lock from dead process", () => {
    const lockPath = join(testDir, "test.lock");
    // Use an absurdly high PID that won't exist
    writeFileSync(lockPath, "999999999");

    acquireLock(lockPath);

    const content = readFileSync(lockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));

    releaseLock(lockPath);
  });

  test("allows child process to take over parent lock via process.ppid", () => {
    const lockPath = join(testDir, "test.lock");
    // Write the current process's parent PID — simulates the upgrade command
    // holding the lock when the child (setup --install) tries to acquire it
    writeFileSync(lockPath, String(process.ppid));

    // Should NOT throw — recognizes parent PID and takes over
    acquireLock(lockPath);

    const content = readFileSync(lockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));

    releaseLock(lockPath);
  });
});

describe("compareVersions", () => {
  test("stable: newer > older", () => {
    expect(compareVersions("0.15.0", "0.14.0")).toBe(1);
  });

  test("stable: older < newer", () => {
    expect(compareVersions("0.14.0", "0.15.0")).toBe(-1);
  });

  test("stable: equal", () => {
    expect(compareVersions("0.14.0", "0.14.0")).toBe(0);
  });

  test("nightly: later timestamp > earlier timestamp", () => {
    expect(
      compareVersions("0.14.0-dev.1772732047", "0.14.0-dev.1772724107")
    ).toBe(1);
  });

  test("nightly: earlier timestamp < later timestamp", () => {
    expect(
      compareVersions("0.14.0-dev.1772724107", "0.14.0-dev.1772732047")
    ).toBe(-1);
  });

  test("nightly: equal", () => {
    expect(
      compareVersions("0.14.0-dev.1772724107", "0.14.0-dev.1772724107")
    ).toBe(0);
  });

  test("stable > nightly with same base (semver: release > pre-release)", () => {
    expect(compareVersions("0.14.0", "0.14.0-dev.1772732047")).toBe(1);
  });
});

describe("isDowngrade", () => {
  test("returns true when target is older stable version", () => {
    expect(isDowngrade("0.15.0", "0.14.0")).toBe(true);
  });

  test("returns false when target is newer stable version", () => {
    expect(isDowngrade("0.14.0", "0.15.0")).toBe(false);
  });

  test("returns false when versions are equal", () => {
    expect(isDowngrade("0.14.0", "0.14.0")).toBe(false);
  });

  test("returns true when target is older nightly (earlier timestamp)", () => {
    expect(isDowngrade("0.14.0-dev.1772732047", "0.14.0-dev.1772724107")).toBe(
      true
    );
  });

  test("returns false when target is newer nightly (later timestamp)", () => {
    expect(isDowngrade("0.14.0-dev.1772724107", "0.14.0-dev.1772732047")).toBe(
      false
    );
  });
});

describe("isMusl", () => {
  test("returns false on non-Linux platforms", () => {
    if (process.platform !== "linux") {
      expect(isMusl()).toBe(false);
    }
  });

  test("returns a boolean on Linux", () => {
    if (process.platform === "linux") {
      expect(typeof isMusl()).toBe("boolean");
    }
  });

  test("result is cached (calling twice returns same value)", () => {
    const first = isMusl();
    const second = isMusl();
    expect(first).toBe(second);
  });
});

describe("getPlatformBinaryName", () => {
  test("starts with sentry- prefix", () => {
    expect(getPlatformBinaryName()).toStartWith("sentry-");
  });

  test("includes correct architecture", () => {
    const name = getPlatformBinaryName();
    const expectedArch = process.arch === "arm64" ? "arm64" : "x64";
    expect(name).toContain(expectedArch);
  });

  test("includes correct OS", () => {
    const name = getPlatformBinaryName();
    if (process.platform === "darwin") {
      expect(name).toContain("darwin");
    } else if (process.platform === "win32") {
      expect(name).toContain("windows");
      expect(name).toEndWith(".exe");
    } else {
      expect(name).toContain("linux");
    }
  });

  test("on CI (glibc), does not contain -musl suffix", () => {
    // CI runners use glibc-based Ubuntu. This test verifies the
    // musl detection correctly identifies glibc systems.
    if (process.platform === "linux" && !isMusl()) {
      expect(getPlatformBinaryName()).not.toContain("-musl");
    }
  });

  test("includes -musl suffix on musl systems", () => {
    // Only runs on musl-based systems (e.g., Alpine CI containers)
    if (process.platform === "linux" && isMusl()) {
      expect(getPlatformBinaryName()).toContain("-musl");
    }
  });
});
