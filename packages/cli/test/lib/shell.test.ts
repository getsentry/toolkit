/**
 * Shell Utilities Tests
 *
 * Unit tests for I/O-dependent shell operations (file creation, writing,
 * GitHub Actions). Pure function tests are in shell.property.test.ts.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addToFpath,
  addToGitHubPath,
  addToPath,
  detectShell,
  findExistingConfigFile,
  getConfigCandidates,
  isBashAvailable,
  isInPath,
} from "../../src/lib/shell.js";
import { whichSync } from "../../src/lib/which.js";

describe("shell utilities", () => {
  describe("getConfigCandidates", () => {
    test("returns fallback candidates for unknown shell", () => {
      const candidates = getConfigCandidates(
        "unknown",
        "/home/user",
        "/home/user/.config"
      );
      expect(candidates).toContain("/home/user/.bashrc");
      expect(candidates).toContain("/home/user/.bash_profile");
      expect(candidates).toContain("/home/user/.profile");
    });
  });

  describe("findExistingConfigFile", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        "/tmp",
        `shell-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    test("returns first existing file", () => {
      const file1 = join(testDir, ".bashrc");
      const file2 = join(testDir, ".bash_profile");
      writeFileSync(file2, "# bash profile");

      const result = findExistingConfigFile([file1, file2]);
      expect(result).toBe(file2);
    });

    test("returns null when no files exist", () => {
      const result = findExistingConfigFile([
        join(testDir, ".nonexistent1"),
        join(testDir, ".nonexistent2"),
      ]);
      expect(result).toBeNull();
    });
  });

  describe("detectShell", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        "/tmp",
        `shell-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    test("detects shell type and finds config file", () => {
      const zshrc = join(testDir, ".zshrc");
      writeFileSync(zshrc, "# zshrc");

      const result = detectShell("/bin/zsh", testDir);
      expect(result.type).toBe("zsh");
      expect(result.configFile).toBe(zshrc);
    });

    test("returns null configFile when none exist", () => {
      const result = detectShell("/bin/zsh", testDir);
      expect(result.type).toBe("zsh");
      expect(result.configFile).toBeNull();
    });
  });

  describe("addToPath", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        "/tmp",
        `shell-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    test("creates config file if it doesn't exist", async () => {
      const configFile = join(testDir, ".bashrc");
      const result = await addToPath(
        configFile,
        "/home/user/.sentry/bin",
        "bash"
      );

      expect(result.modified).toBe(true);
      expect(result.configFile).toBe(configFile);

      const content = await readFile(configFile, "utf-8");
      expect(content).toContain('export PATH="/home/user/.sentry/bin:$PATH"');
    });

    test("appends to existing config file", async () => {
      const configFile = join(testDir, ".bashrc");
      writeFileSync(configFile, "# existing content\n");

      const result = await addToPath(
        configFile,
        "/home/user/.sentry/bin",
        "bash"
      );

      expect(result.modified).toBe(true);

      const content = await readFile(configFile, "utf-8");
      expect(content).toContain("# existing content");
      expect(content).toContain("# sentry");
      expect(content).toContain('export PATH="/home/user/.sentry/bin:$PATH"');
    });

    test("skips if already configured", async () => {
      const configFile = join(testDir, ".bashrc");
      writeFileSync(
        configFile,
        '# sentry\nexport PATH="/home/user/.sentry/bin:$PATH"\n'
      );

      const result = await addToPath(
        configFile,
        "/home/user/.sentry/bin",
        "bash"
      );

      expect(result.modified).toBe(false);
      expect(result.message).toContain("already configured");
    });

    test("appends newline separator when file doesn't end with newline", async () => {
      const configFile = join(testDir, ".bashrc");
      writeFileSync(configFile, "# existing content without newline");

      const result = await addToPath(
        configFile,
        "/home/user/.sentry/bin",
        "bash"
      );

      expect(result.modified).toBe(true);

      const content = await readFile(configFile, "utf-8");
      expect(content).toContain(
        "# existing content without newline\n\n# sentry\n"
      );
    });

    test("returns manualCommand when config file cannot be created", async () => {
      const configFile = "/dev/null/impossible/path/.bashrc";
      const result = await addToPath(
        configFile,
        "/home/user/.sentry/bin",
        "bash"
      );

      expect(result.modified).toBe(false);
      expect(result.manualCommand).toBe(
        'export PATH="/home/user/.sentry/bin:$PATH"'
      );
    });
  });

  describe("addToFpath", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        "/tmp",
        `shell-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    test("creates config file if it doesn't exist", async () => {
      const configFile = join(testDir, ".zshrc");
      const result = await addToFpath(
        configFile,
        "/home/user/.local/share/zsh/site-functions"
      );

      expect(result.modified).toBe(true);
      expect(result.configFile).toBe(configFile);

      const content = await readFile(configFile, "utf-8");
      expect(content).toContain(
        'fpath=("/home/user/.local/share/zsh/site-functions" $fpath)'
      );
    });

    test("appends to existing config file", async () => {
      const configFile = join(testDir, ".zshrc");
      writeFileSync(configFile, "# existing content\n");

      const result = await addToFpath(
        configFile,
        "/home/user/.local/share/zsh/site-functions"
      );

      expect(result.modified).toBe(true);

      const content = await readFile(configFile, "utf-8");
      expect(content).toContain("# existing content");
      expect(content).toContain("# sentry");
      expect(content).toContain(
        'fpath=("/home/user/.local/share/zsh/site-functions" $fpath)'
      );
    });

    test("skips if already configured", async () => {
      const configFile = join(testDir, ".zshrc");
      writeFileSync(
        configFile,
        '# sentry\nfpath=("/home/user/.local/share/zsh/site-functions" $fpath)\n'
      );

      const result = await addToFpath(
        configFile,
        "/home/user/.local/share/zsh/site-functions"
      );

      expect(result.modified).toBe(false);
      expect(result.message).toContain("already configured");
    });

    test("appends newline separator when file doesn't end with newline", async () => {
      const configFile = join(testDir, ".zshrc");
      writeFileSync(configFile, "# existing content without newline");

      const result = await addToFpath(
        configFile,
        "/home/user/.local/share/zsh/site-functions"
      );

      expect(result.modified).toBe(true);

      const content = await readFile(configFile, "utf-8");
      expect(content).toContain(
        "# existing content without newline\n\n# sentry\n"
      );
    });

    test("returns manualCommand when config file cannot be created", async () => {
      const configFile = "/dev/null/impossible/path/.zshrc";
      const result = await addToFpath(
        configFile,
        "/home/user/.local/share/zsh/site-functions"
      );

      expect(result.modified).toBe(false);
      expect(result.manualCommand).toBe(
        'fpath=("/home/user/.local/share/zsh/site-functions" $fpath)'
      );
    });
  });

  describe("addToGitHubPath", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(
        "/tmp",
        `shell-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    test("returns false when not in GitHub Actions", async () => {
      const result = await addToGitHubPath("/usr/local/bin", {});
      expect(result).toBe(false);
    });

    test("returns false when GITHUB_PATH is not set", async () => {
      const result = await addToGitHubPath("/usr/local/bin", {
        GITHUB_ACTIONS: "true",
      });
      expect(result).toBe(false);
    });

    test("writes directory to GITHUB_PATH file", async () => {
      const pathFile = join(testDir, "github_path");
      writeFileSync(pathFile, "");

      const result = await addToGitHubPath("/usr/local/bin", {
        GITHUB_ACTIONS: "true",
        GITHUB_PATH: pathFile,
      });

      expect(result).toBe(true);
      const content = await readFile(pathFile, "utf-8");
      expect(content).toContain("/usr/local/bin");
    });

    test("does not duplicate existing directory", async () => {
      const pathFile = join(testDir, "github_path");
      writeFileSync(pathFile, "/usr/local/bin\n");

      const result = await addToGitHubPath("/usr/local/bin", {
        GITHUB_ACTIONS: "true",
        GITHUB_PATH: pathFile,
      });

      expect(result).toBe(true);
      const content = await readFile(pathFile, "utf-8");
      expect(content).toBe("/usr/local/bin\n");
    });

    test("returns false when GITHUB_PATH file is not writable", async () => {
      const result = await addToGitHubPath("/usr/local/bin", {
        GITHUB_ACTIONS: "true",
        GITHUB_PATH: "/dev/null/impossible",
      });

      expect(result).toBe(false);
    });
  });
});

describe("isInPath", () => {
  const sep = process.platform === "win32" ? ";" : ":";

  test("returns true for an exact match", () => {
    expect(isInPath("/usr/local/bin", `/usr/bin${sep}/usr/local/bin`)).toBe(
      true
    );
  });

  test("returns false when the directory is absent", () => {
    expect(isInPath("/opt/bin", `/usr/bin${sep}/usr/local/bin`)).toBe(false);
  });

  test("returns false for undefined or empty PATH", () => {
    expect(isInPath("/usr/bin", undefined)).toBe(false);
    expect(isInPath("/usr/bin", "")).toBe(false);
  });

  test("case sensitivity follows the platform", () => {
    const result = isInPath("/Users/User/.local/bin", "/users/user/.local/bin");
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(result).toBe(true);
    } else {
      expect(result).toBe(false);
    }
  });
});

describe("isBashAvailable", () => {
  test("returns true when bash is in PATH", () => {
    // Point PATH at the directory containing bash
    const bashPath = whichSync("bash");
    if (!bashPath) {
      // Skip if bash truly isn't on this system
      return;
    }
    expect(isBashAvailable(dirname(bashPath))).toBe(true);
  });

  test("returns false when PATH has no bash", () => {
    expect(isBashAvailable("/nonexistent")).toBe(false);
  });

  test("returns false when PATH is empty", () => {
    expect(isBashAvailable("")).toBe(false);
  });
});
