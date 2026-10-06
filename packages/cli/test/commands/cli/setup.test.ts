/**
 * Setup Command Tests
 *
 * Tests the `sentry cli setup` command end-to-end through Stricli's run().
 *
 * Status messages go through consola (→ process.stderr). Tests capture stderr
 * via a spy on process.stderr.write and assert on the collected output.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isatty } from "node:tty";
import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:tty", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:tty")>()),
  isatty: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../src/lib/interactive-login.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/lib/interactive-login.js")
  >()),
  runInteractiveLogin: vi.fn(),
}));

vi.mock("../../../src/lib/scope-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/lib/scope-recovery.js")
  >()),
  ensureCurrentOAuthScopes: vi.fn(),
}));

import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
import { getAuthConfig, setAuthToken } from "../../../src/lib/db/auth.js";
import {
  getAgentSkillsPreference,
  setAgentSkillsPreference,
} from "../../../src/lib/db/defaults.js";
import {
  clearInstallInfo,
  getInstallInfo,
} from "../../../src/lib/db/install-info.js";
import { getReleaseChannel } from "../../../src/lib/db/release-channel.js";
import {
  getProcessInfoFromOS,
  setProcessInfoProvider,
} from "../../../src/lib/detect-agent.js";
import { setEnv } from "../../../src/lib/env.js";
// biome-ignore lint/performance/noNamespaceImport: dynamic setup imports are mocked at the module boundary
import * as interactiveLogin from "../../../src/lib/interactive-login.js";
// biome-ignore lint/performance/noNamespaceImport: dynamic setup imports are mocked at the module boundary
import * as scopeRecovery from "../../../src/lib/scope-recovery.js";
import { useTestConfigDir } from "../../helpers.js";

/** Store original fetch for restoration */
let originalFetch: typeof globalThis.fetch;

/** Helper to mock fetch without TypeScript errors about missing Bun-specific properties */
function mockFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

/**
 * Create a mock Stricli context and a stderr capture for consola output.
 *
 * The context provides process/env stubs for the setup command, while
 * `getOutput()` returns the combined consola output captured from
 * `process.stderr.write` (where consola routes all messages).
 */
function createMockContext(
  overrides: Partial<{
    homeDir: string;
    env: Record<string, string | undefined>;
    execPath: string;
  }> = {}
): {
  context: SentryContext;
  getOutput: () => string;
  clearOutput: () => void;
  restore: () => void;
} {
  const stderrChunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const env: Record<string, string | undefined> = {
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/bash",
    ...overrides.env,
  };

  const stdoutChunks: string[] = [];
  const context = {
    process: {
      stdout: {
        write: vi.fn((s: string) => {
          stdoutChunks.push(String(s));
          return true;
        }),
      },
      stderr: {
        write: vi.fn((_s: string) => true),
      },
      stdin: process.stdin,
      env,
      cwd: () => "/tmp",
      execPath: overrides.execPath ?? "/usr/local/bin/sentry",
      exit: vi.fn(() => {
        // no-op for tests
      }),
      exitCode: 0,
    },
    homeDir: overrides.homeDir ?? "/tmp/test-home",
    cwd: "/tmp",
    configDir: "/tmp/test-config",
    env,
    stdout: {
      write: vi.fn((s: string) => {
        stdoutChunks.push(String(s));
        return true;
      }),
    },
    stderr: {
      write: vi.fn((_s: string) => true),
    },
    stdin: process.stdin,
    setFlags: () => {
      // no-op for tests
    },
  } as unknown as SentryContext;

  return {
    context,
    getOutput: () => stdoutChunks.join("") + stderrChunks.join(""),
    clearOutput: () => {
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
    },
    restore: () => {
      process.stderr.write = origWrite;
    },
  };
}

describe("sentry cli setup", () => {
  let testDir: string;
  let restoreStderr: (() => void) | undefined;

  beforeEach(() => {
    testDir = join(
      "/tmp",
      `setup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    vi.mocked(scopeRecovery.ensureCurrentOAuthScopes).mockResolvedValue(false);
  });

  afterEach(() => {
    restoreStderr?.();
    restoreStderr = undefined;
    rmSync(testDir, { recursive: true, force: true });
    vi.mocked(scopeRecovery.ensureCurrentOAuthScopes).mockReset();
  });

  test("runs with --quiet and skips all output", async () => {
    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
    });
    restoreStderr = restore;

    await run(
      app,
      [
        "cli",
        "setup",
        "--quiet",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
      ],
      context
    );

    // With --quiet, no output should be produced
    expect(getOutput()).toBe("");
  });

  test("checks OAuth scopes when invoked by the upgrade command", async () => {
    const { context, restore } = createMockContext({ homeDir: testDir });
    restoreStderr = restore;

    await run(
      app,
      [
        "cli",
        "setup",
        "--quiet",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
        "--ensure-auth-scopes",
      ],
      context
    );

    expect(scopeRecovery.ensureCurrentOAuthScopes).toHaveBeenCalledOnce();
    expect(scopeRecovery.ensureCurrentOAuthScopes).toHaveBeenCalledWith(
      interactiveLogin.runInteractiveLogin
    );
  });

  test("produces no welcome or completion output without --install", async () => {
    // Without --install, setup is being called for an upgrade or manual re-run.
    // Output is suppressed — the upgrade command itself prints success.
    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
    });
    restoreStderr = restore;

    await run(
      app,
      [
        "cli",
        "setup",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
      ],
      context
    );

    expect(getOutput()).toBe("");
  });

  test("records install method when --method is provided", async () => {
    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
    });
    restoreStderr = restore;

    await run(
      app,
      [
        "cli",
        "setup",
        "--method",
        "curl",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
      ],
      context
    );

    expect(getOutput()).toContain("Recorded installation method: curl");
  });

  test("handles PATH modification when binary not in PATH", async () => {
    // Create a .bashrc for the shell config to find
    const bashrc = join(testDir, ".bashrc");
    writeFileSync(bashrc, "# existing config\n");

    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "bin", "sentry"),
      env: {
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/bash",
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-completions", "--no-agent-skills"],
      context
    );

    expect(getOutput()).toContain("PATH:");
  });

  test("reports PATH already configured when binary dir is in PATH", async () => {
    const binDir = join(testDir, "bin");
    mkdirSync(binDir, { recursive: true });

    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(binDir, "sentry"),
      env: {
        PATH: `/usr/bin:${binDir}:/bin`,
        SHELL: "/bin/bash",
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-completions", "--no-agent-skills"],
      context
    );

    expect(getOutput()).toContain("already in PATH");
  });

  test("reports no config file found for unknown shell", async () => {
    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      env: {
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/tcsh",
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-completions", "--no-agent-skills"],
      context
    );

    expect(getOutput()).toContain("No shell config file found");
    expect(getOutput()).toContain("Add manually");
  });

  test("installs completions when not skipped", async () => {
    const bashrc = join(testDir, ".bashrc");
    writeFileSync(bashrc, "# existing\n");

    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "bin", "sentry"),
      env: {
        PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
        SHELL: "/bin/bash",
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-modify-path", "--no-agent-skills"],
      context
    );

    expect(getOutput()).toContain("Completions:");
  });

  test("adds fpath to .zshrc for zsh completions", async () => {
    const zshrc = join(testDir, ".zshrc");
    writeFileSync(zshrc, "# existing zshrc\n");

    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "bin", "sentry"),
      env: {
        PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
        SHELL: "/bin/zsh",
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-modify-path", "--no-agent-skills"],
      context
    );

    expect(getOutput()).toContain("fpath");
    expect(getOutput()).toContain("Completions:");

    // Verify .zshrc was actually modified
    const content = await readFile(zshrc, "utf-8");
    expect(content).toContain("fpath=");
    expect(content).toContain("site-functions");
  });

  test("skips fpath modification when already configured in .zshrc", async () => {
    const zshrc = join(testDir, ".zshrc");
    const completionDir = join(
      testDir,
      ".local",
      "share",
      "zsh",
      "site-functions"
    );
    writeFileSync(zshrc, `# existing\nfpath=("${completionDir}" $fpath)\n`);

    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "bin", "sentry"),
      env: {
        PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
        SHELL: "/bin/zsh",
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-modify-path", "--no-agent-skills"],
      context
    );

    // Should still show "Installed to" but not "Added ... to fpath"
    const output = getOutput();
    expect(output).toContain("Completions: Installed to");
    expect(output).not.toContain("Added sentry fpath in");
  });

  test("handles GitHub Actions PATH when GITHUB_ACTIONS is set", async () => {
    const ghPathFile = join(testDir, "github_path");
    writeFileSync(ghPathFile, "");

    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "bin", "sentry"),
      env: {
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/bash",
        GITHUB_ACTIONS: "true",
        GITHUB_PATH: ghPathFile,
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-completions", "--no-agent-skills"],
      context
    );

    expect(getOutput()).toContain("GITHUB_PATH");
  });

  test("falls back to bash completions for unsupported shell when bash is available", async () => {
    // Create a fake bash executable in testDir/bin so isBashAvailable() returns
    // true with PATH pointing there — no dependency on the host system.
    const binDir = join(testDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const { chmodSync, writeFileSync: wf } = await import("node:fs");
    const fakeBash = join(binDir, "bash");
    wf(fakeBash, "#!/bin/sh\necho fake-bash");
    chmodSync(fakeBash, 0o755);

    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "bin", "sentry"),
      env: {
        PATH: binDir,
        SHELL: "/bin/xonsh",
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-modify-path", "--no-agent-skills"],
      context
    );

    expect(getOutput()).toContain(
      "Your shell (xonsh) is not directly supported"
    );
    expect(getOutput()).toContain("bash completions as a fallback");
    expect(getOutput()).toContain("bash-completion");
  });

  test("silently skips completions for unsupported shell when bash is not in PATH", async () => {
    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "bin", "sentry"),
      env: {
        // Empty PATH so isBashAvailable() returns false
        PATH: "",
        SHELL: "/bin/xonsh",
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-modify-path", "--no-agent-skills"],
      context
    );

    // Nothing actionable — no message produced
    expect(getOutput()).not.toContain("Completions:");
    expect(getOutput()).not.toContain("Not supported");
  });

  test("suppresses completion messages on subsequent runs (upgrade scenario)", async () => {
    const { context, getOutput, clearOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "bin", "sentry"),
      env: {
        PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
        SHELL: "/bin/bash",
      },
    });
    restoreStderr = restore;

    // First run — should show "Installed to"
    await run(
      app,
      ["cli", "setup", "--no-modify-path", "--no-agent-skills"],
      context
    );

    expect(getOutput()).toContain("Completions: Installed to");

    // Second run — completion file already exists, should be silent
    clearOutput();
    await run(
      app,
      ["cli", "setup", "--no-modify-path", "--no-agent-skills"],
      context
    );

    expect(getOutput()).not.toContain("Completions:");
  });

  test("silently skips completions for sh shell", async () => {
    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "bin", "sentry"),
      env: {
        PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
        SHELL: "/bin/sh",
      },
    });
    restoreStderr = restore;

    await run(
      app,
      ["cli", "setup", "--no-modify-path", "--no-agent-skills"],
      context
    );

    // sh/ash shells silently skip completions — no message at all
    expect(getOutput()).not.toContain("Completions:");
  });

  test("supports kebab-case flags", async () => {
    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
    });
    restoreStderr = restore;

    // Verify kebab-case works (--no-modify-path instead of --noModifyPath)
    await run(
      app,
      [
        "cli",
        "setup",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
        "--quiet",
      ],
      context
    );

    // Should not error
    expect(getOutput()).toBe("");
  });

  describe("--install flag", () => {
    test("installs binary from temp location and shows welcome message", async () => {
      // Create a fake source binary to "install"
      const sourceDir = join(testDir, "tmp");
      mkdirSync(sourceDir, { recursive: true });
      const sourcePath = join(sourceDir, "sentry-download");
      writeFileSync(sourcePath, "#!/bin/sh\necho test-binary");
      const { chmodSync } = await import("node:fs");
      chmodSync(sourcePath, 0o755);

      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: sourcePath,
        env: {
          PATH: "/usr/bin:/bin",
          SHELL: "/bin/bash",
          SENTRY_INSTALL_DIR: join(testDir, "install-dir"),
        },
      });
      restoreStderr = restore;

      await run(
        app,
        [
          "cli",
          "setup",
          "--install",
          "--method",
          "curl",
          "--no-modify-path",
          "--no-completions",
          "--no-agent-skills",
        ],
        context
      );

      const combined = getOutput();

      // Should show welcome message, not "Setup complete!"
      expect(combined).toContain("Installed sentry v");
      expect(combined).toContain("Get started:");
      expect(combined).toContain("sentry auth");
      expect(combined).toContain("sentry --help");
      expect(combined).toContain("cli.sentry.dev");
      expect(combined).not.toContain("Setup complete!");

      // Should install binary to the target directory
      const installedPath = join(testDir, "install-dir", "sentry");
      expect(existsSync(installedPath)).toBe(true);
    });

    test("does not log 'Recorded installation method' with --install", async () => {
      const sourceDir = join(testDir, "tmp");
      mkdirSync(sourceDir, { recursive: true });
      const sourcePath = join(sourceDir, "sentry-download");
      writeFileSync(sourcePath, "binary-content");
      const { chmodSync } = await import("node:fs");
      chmodSync(sourcePath, 0o755);

      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: sourcePath,
        env: {
          PATH: "/usr/bin:/bin",
          SHELL: "/bin/bash",
          SENTRY_INSTALL_DIR: join(testDir, "install-dir"),
        },
      });
      restoreStderr = restore;

      await run(
        app,
        [
          "cli",
          "setup",
          "--install",
          "--method",
          "curl",
          "--no-modify-path",
          "--no-completions",
          "--no-agent-skills",
        ],
        context
      );

      // With --install, the "Recorded installation method" log is suppressed
      expect(getOutput()).not.toContain("Recorded installation method");
    });

    test("--install suppresses welcome when binary already exists (upgrade)", async () => {
      const installDir = join(testDir, "install-dir");
      mkdirSync(installDir, { recursive: true });
      // Pre-existing binary — this is an upgrade, not a fresh install
      writeFileSync(join(installDir, "sentry"), "old-binary");

      const sourceDir = join(testDir, "tmp");
      mkdirSync(sourceDir, { recursive: true });
      const sourcePath = join(sourceDir, "sentry-download");
      writeFileSync(sourcePath, "new-binary");
      const { chmodSync } = await import("node:fs");
      chmodSync(sourcePath, 0o755);

      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: sourcePath,
        env: {
          PATH: "/usr/bin:/bin",
          SHELL: "/bin/bash",
          SENTRY_INSTALL_DIR: installDir,
        },
      });
      restoreStderr = restore;

      await run(
        app,
        [
          "cli",
          "setup",
          "--install",
          "--method",
          "curl",
          "--no-modify-path",
          "--no-completions",
          "--no-agent-skills",
        ],
        context
      );

      const combined = getOutput();

      // Binary placement is still logged
      expect(combined).toContain("Binary: Installed to");
      // But welcome/getting-started is suppressed for upgrades
      expect(combined).not.toContain("Get started:");
      expect(combined).not.toContain("Authenticate with Sentry");
    });

    test("--install with --quiet suppresses all output", async () => {
      const sourceDir = join(testDir, "tmp");
      mkdirSync(sourceDir, { recursive: true });
      const sourcePath = join(sourceDir, "sentry-download");
      writeFileSync(sourcePath, "binary-content");
      const { chmodSync } = await import("node:fs");
      chmodSync(sourcePath, 0o755);

      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: sourcePath,
        env: {
          PATH: "/usr/bin:/bin",
          SHELL: "/bin/bash",
          SENTRY_INSTALL_DIR: join(testDir, "install-dir"),
        },
      });
      restoreStderr = restore;

      await run(
        app,
        [
          "cli",
          "setup",
          "--install",
          "--method",
          "curl",
          "--no-modify-path",
          "--no-completions",
          "--no-agent-skills",
          "--quiet",
        ],
        context
      );

      expect(getOutput()).toBe("");
    });
  });

  describe("login after a fresh curl install", () => {
    const getConfigDir = useTestConfigDir("setup-login-");

    beforeEach(() => {
      vi.mocked(isatty).mockReturnValue(true);
      setProcessInfoProvider(async () => ({ name: "bash", ppid: 1 }));
      vi.mocked(interactiveLogin.runInteractiveLogin).mockResolvedValue(null);
    });

    afterEach(() => {
      vi.mocked(isatty).mockReturnValue(false);
      vi.mocked(interactiveLogin.runInteractiveLogin).mockReset();
      setProcessInfoProvider(getProcessInfoFromOS);
      setEnv(process.env);
    });

    /** Prepare a real binary install with isolated auth and captured output. */
    function createInstall(
      options: {
        env?: Record<string, string>;
        flags?: string[];
        existingBinary?: boolean;
        install?: boolean;
        method?: string;
      } = {}
    ) {
      const sourcePath = join(testDir, "sentry-download");
      const installDir = join(testDir, "install-dir");
      const binaryPath = join(installDir, "sentry");
      writeFileSync(sourcePath, "fixture-binary", { mode: 0o755 });
      if (options.existingBinary) {
        mkdirSync(installDir);
        writeFileSync(binaryPath, "old-binary");
      }
      const mock = createMockContext({
        homeDir: testDir,
        execPath: sourcePath,
        env: {
          SENTRY_INSTALL_DIR: installDir,
          SENTRY_CONFIG_DIR: getConfigDir(),
          SENTRY_CLI_NO_TELEMETRY: "1",
          ...options.env,
        },
      });
      restoreStderr = mock.restore;
      mock.context.process.exitCode = undefined;
      setEnv(mock.context.env);

      return {
        ...mock,
        binaryPath,
        run: () =>
          run(
            app,
            [
              "cli",
              "setup",
              ...(options.install === false ? [] : ["--install"]),
              "--method",
              options.method ?? "curl",
              "--no-modify-path",
              "--no-completions",
              "--no-agent-skills",
              ...(options.flags ?? []),
            ],
            mock.context
          ),
      };
    }

    test("starts OAuth only after installing the binary and displaying success", async () => {
      const fixture = createInstall();
      vi.mocked(interactiveLogin.runInteractiveLogin).mockImplementation(
        async () => {
          expect(readFileSync(fixture.binaryPath, "utf8")).toBe(
            "fixture-binary"
          );
          expect(fixture.getOutput()).toContain("Installed sentry v");
          return { method: "oauth", configPath: getConfigDir() };
        }
      );

      await fixture.run();

      expect(interactiveLogin.runInteractiveLogin).toHaveBeenCalledOnce();
      expect(fixture.context.process.exitCode).toBe(0);
      expect(fixture.getOutput()).toContain("Authenticated with Sentry.");
    });

    test.each([0, 1, 2])("skips login when fd %i is not a TTY", async (fd) => {
      vi.mocked(isatty).mockImplementation((candidate) => candidate !== fd);
      const fixture = createInstall();
      await fixture.run();
      expect(interactiveLogin.runInteractiveLogin).not.toHaveBeenCalled();
      expect(fixture.context.process.exitCode).toBe(0);
    });

    test("skips an agent identified by the environment", async () => {
      const fixture = createInstall({ env: { AI_AGENT: "claude" } });
      await fixture.run();
      expect(interactiveLogin.runInteractiveLogin).not.toHaveBeenCalled();
      expect(fixture.context.process.exitCode).toBe(0);
    });

    test("waits for process-tree agent detection before starting OAuth", async () => {
      setProcessInfoProvider(async () => {
        await Promise.resolve();
        return { name: "codex", ppid: 1 };
      });
      const fixture = createInstall();
      await fixture.run();
      expect(interactiveLogin.runInteractiveLogin).not.toHaveBeenCalled();
      expect(fixture.context.process.exitCode).toBe(0);
    });

    test("preserves an expired access token with a usable refresh token", async () => {
      const fixture = createInstall();
      setAuthToken("stored-token", -1, "refresh-token");
      await fixture.run();
      expect(interactiveLogin.runInteractiveLogin).not.toHaveBeenCalled();
      expect(getAuthConfig()).toMatchObject({
        token: "stored-token",
        refreshToken: "refresh-token",
      });
      expect(fixture.context.process.exitCode).toBe(0);
    });

    test.each([
      { env: { SENTRY_INIT: "1" } },
      { env: { SENTRY_AUTH_TOKEN: "existing-token" } },
      { env: { SENTRY_OUTPUT_FORMAT: "json" } },
      { flags: ["--quiet"] },
      { flags: ["--json"] },
      { flags: ["--ensure-auth-scopes"] },
      { existingBinary: true },
      { install: false },
      { method: "npm" },
    ])("keeps login out of other setup flows: %j", async (options) => {
      const fixture = createInstall(options);
      await fixture.run();
      expect(interactiveLogin.runInteractiveLogin).not.toHaveBeenCalled();
      expect(fixture.context.process.exitCode).toBe(0);
    });

    test("refuses an untrusted OAuth host without failing installation", async () => {
      const fixture = createInstall({
        env: { SENTRY_HOST: "https://sentry.example.com" },
      });
      await fixture.run();
      expect(interactiveLogin.runInteractiveLogin).not.toHaveBeenCalled();
      expect(fixture.getOutput()).toContain("Refusing to log in against");
      expect(fixture.context.process.exitCode).toBe(0);
      expect(readFileSync(fixture.binaryPath, "utf8")).toBe("fixture-binary");
    });

    test.each([
      false,
      true,
    ])("keeps installation successful when OAuth fails (throws: %s)", async (throws) => {
      if (throws) {
        vi.mocked(interactiveLogin.runInteractiveLogin).mockRejectedValue(
          new Error("OAuth unavailable")
        );
      }
      const fixture = createInstall();
      await fixture.run();
      expect(interactiveLogin.runInteractiveLogin).toHaveBeenCalledOnce();
      expect(fixture.context.process.exitCode).toBe(0);
      expect(readFileSync(fixture.binaryPath, "utf8")).toBe("fixture-binary");
      expect(fixture.getOutput()).toContain(
        throws
          ? "Authentication failed: OAuth unavailable"
          : "Run 'sentry auth login' to authenticate later."
      );
    });
  });

  describe("agent skills", () => {
    beforeEach(() => {
      // Reset the persisted preference — the config DB is shared across tests
      // in this file, so a prior --no-agent-skills run would otherwise leak.
      setAgentSkillsPreference(null);
      originalFetch = globalThis.fetch;
      mockFetch(
        async () =>
          new Response("# Sentry CLI Skill\nTest content", { status: 200 })
      );
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      setAgentSkillsPreference(null);
    });

    test("installs agent skills when Claude Code is detected", async () => {
      // Create ~/.claude to simulate Claude Code being installed
      mkdirSync(join(testDir, ".claude"), { recursive: true });

      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: join(testDir, "bin", "sentry"),
        env: {
          PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
          SHELL: "/bin/bash",
        },
      });
      restoreStderr = restore;

      await run(
        app,
        ["cli", "setup", "--no-modify-path", "--no-completions"],
        context
      );

      expect(getOutput()).toContain("Agent skills:");
      expect(getOutput()).toContain("Installed to");

      // Verify the file was actually written
      const skillPath = join(
        testDir,
        ".claude",
        "skills",
        "sentry-cli",
        "SKILL.md"
      );
      expect(existsSync(skillPath)).toBe(true);
    });

    test("silently skips when no supported agent root is detected", async () => {
      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: join(testDir, "bin", "sentry"),
        env: {
          PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
          SHELL: "/bin/bash",
        },
      });
      restoreStderr = restore;

      await run(
        app,
        ["cli", "setup", "--no-modify-path", "--no-completions"],
        context
      );

      expect(getOutput()).not.toContain("Agent skills:");
    });

    test("installs to ~/.agents/ when the shared agent root is detected", async () => {
      mkdirSync(join(testDir, ".agents"), { recursive: true });

      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: join(testDir, "bin", "sentry"),
        env: {
          PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
          SHELL: "/bin/bash",
        },
      });
      restoreStderr = restore;

      await run(
        app,
        ["cli", "setup", "--no-modify-path", "--no-completions"],
        context
      );

      expect(getOutput()).toContain("Agent skills: Installed to");
      expect(
        existsSync(join(testDir, ".agents", "skills", "sentry-cli", "SKILL.md"))
      ).toBe(true);
      expect(
        existsSync(join(testDir, ".claude", "skills", "sentry-cli", "SKILL.md"))
      ).toBe(false);
    });

    test("suppresses agent skills message on subsequent runs (upgrade scenario)", async () => {
      mkdirSync(join(testDir, ".claude"), { recursive: true });

      const { context, getOutput, clearOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: join(testDir, "bin", "sentry"),
        env: {
          PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
          SHELL: "/bin/bash",
        },
      });
      restoreStderr = restore;

      // First run — should show "Installed to"
      await run(
        app,
        ["cli", "setup", "--no-modify-path", "--no-completions"],
        context
      );

      expect(getOutput()).toContain("Agent skills: Installed to");

      // Second run — skill file already exists, should be silent
      clearOutput();
      await run(
        app,
        ["cli", "setup", "--no-modify-path", "--no-completions"],
        context
      );

      expect(getOutput()).not.toContain("Agent skills:");
    });

    test("skips when --no-agent-skills is set", async () => {
      mkdirSync(join(testDir, ".claude"), { recursive: true });

      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: join(testDir, "bin", "sentry"),
        env: {
          PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
          SHELL: "/bin/bash",
        },
      });
      restoreStderr = restore;

      await run(
        app,
        [
          "cli",
          "setup",
          "--no-modify-path",
          "--no-completions",
          "--no-agent-skills",
        ],
        context
      );

      expect(getOutput()).not.toContain("Agent skills:");
    });

    test("persists the opt-out when --no-agent-skills is passed", async () => {
      mkdirSync(join(testDir, ".claude"), { recursive: true });

      const { context, restore } = createMockContext({
        homeDir: testDir,
        execPath: join(testDir, "bin", "sentry"),
        env: {
          PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
          SHELL: "/bin/bash",
        },
      });
      restoreStderr = restore;

      await run(
        app,
        [
          "cli",
          "setup",
          "--no-modify-path",
          "--no-completions",
          "--no-agent-skills",
        ],
        context
      );

      expect(getAgentSkillsPreference()).toBe(false);
    });

    test("honors a persisted opt-out without the flag (upgrade scenario)", async () => {
      // Simulate a prior `--no-agent-skills` run having stored the preference.
      setAgentSkillsPreference(false);
      mkdirSync(join(testDir, ".claude"), { recursive: true });

      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: join(testDir, "bin", "sentry"),
        env: {
          PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
          SHELL: "/bin/bash",
        },
      });
      restoreStderr = restore;

      // No --no-agent-skills flag — the upgrade command re-runs setup this way.
      await run(
        app,
        ["cli", "setup", "--no-modify-path", "--no-completions"],
        context
      );

      expect(getOutput()).not.toContain("Agent skills:");
      expect(
        existsSync(join(testDir, ".claude", "skills", "sentry-cli", "SKILL.md"))
      ).toBe(false);
    });

    test("installs embedded skill files when Claude Code is detected", async () => {
      mkdirSync(join(testDir, ".claude"), { recursive: true });

      const { context, getOutput, restore } = createMockContext({
        homeDir: testDir,
        execPath: join(testDir, "bin", "sentry"),
        env: {
          PATH: `/usr/bin:${join(testDir, "bin")}:/bin`,
          SHELL: "/bin/bash",
        },
      });
      restoreStderr = restore;

      await run(
        app,
        ["cli", "setup", "--no-modify-path", "--no-completions"],
        context
      );

      // Skill files are embedded at build time, so installation should succeed
      expect(getOutput()).toContain("Agent skills:");
    });

    test("setup completes gracefully when completion directory is not writable", async () => {
      // Make the completions dir unwritable so write() can't write the
      // completion script. installCompletions() catches the permission error
      // and returns null — setup completes without error or warning.
      const { chmodSync: chmod } = await import("node:fs");
      const homeDir = join(testDir, "home");
      const xdgData = join(homeDir, ".local", "share");
      mkdirSync(xdgData, { recursive: true });
      // Create the zsh site-functions dir as unwritable so Bun.write() fails
      const zshDir = join(xdgData, "zsh", "site-functions");
      mkdirSync(zshDir, { recursive: true });
      chmod(zshDir, 0o444); // read-only → completion write will throw

      const { context, getOutput, restore } = createMockContext({
        homeDir,
        env: {
          XDG_DATA_HOME: xdgData,
          PATH: "/usr/bin:/bin",
          SHELL: "/bin/zsh",
        },
      });
      restoreStderr = restore;

      await run(
        app,
        ["cli", "setup", "--no-modify-path", "--no-agent-skills"],
        context
      );

      const combined = getOutput();
      // installCompletions handles permission errors gracefully and returns
      // null, so bestEffort never sees an error — no failure message appears
      expect(combined).not.toContain("Shell completions failed");
      // No misleading fallback message for a supported shell (zsh)
      expect(combined).not.toContain("not directly supported");
      // Setup still completes successfully
      expect(combined).not.toContain("error");

      chmod(zshDir, 0o755);
    });
  });
});

describe("sentry cli setup — legacy migration", () => {
  let testHome: string;
  let restoreStderr: (() => void) | undefined;

  beforeEach(() => {
    testHome = join(
      "/tmp",
      `setup-mig-home-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    restoreStderr?.();
    restoreStderr = undefined;
    rmSync(testHome, { recursive: true, force: true });
  });

  const setupArgs = [
    "cli",
    "setup",
    "--quiet",
    "--no-modify-path",
    "--no-completions",
    "--no-agent-skills",
  ];

  test("migrates legacy ~/.sentry config into the XDG config dir", async () => {
    const configDir = join(testHome, "config", "sentry");
    const legacyDir = join(testHome, ".sentry");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "cli.db"), "legacy-db");

    const { context, restore } = createMockContext({
      homeDir: testHome,
      env: { SENTRY_CONFIG_DIR: configDir },
    });
    restoreStderr = restore;

    await run(app, setupArgs, context);

    const moved = join(configDir, "cli.db");
    expect(existsSync(moved)).toBe(true);
    expect(await readFile(moved, "utf8")).toBe("legacy-db");
    expect(existsSync(join(legacyDir, "cli.db"))).toBe(false);
  });

  test("migrates a legacy ~/.sentry/bin binary to the install dir", async () => {
    const installDir = join(testHome, "install", "bin");
    const legacyBinDir = join(testHome, ".sentry", "bin");
    mkdirSync(legacyBinDir, { recursive: true });
    writeFileSync(join(legacyBinDir, "sentry"), "legacy-binary");

    const { context, restore } = createMockContext({
      homeDir: testHome,
      env: { SENTRY_INSTALL_DIR: installDir },
    });
    restoreStderr = restore;

    await run(app, setupArgs, context);

    const moved = join(installDir, "sentry");
    expect(existsSync(moved)).toBe(true);
    expect(await readFile(moved, "utf8")).toBe("legacy-binary");
    expect(existsSync(join(legacyBinDir, "sentry"))).toBe(false);
    // The migrated binary must remain executable.
    if (process.platform !== "win32") {
      expect(() => accessSync(moved, constants.X_OK)).not.toThrow();
    }
  });

  test("does not overwrite an existing binary at the target", async () => {
    const installDir = join(testHome, "install", "bin");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "sentry"), "current-binary");

    const legacyBinDir = join(testHome, ".sentry", "bin");
    mkdirSync(legacyBinDir, { recursive: true });
    writeFileSync(join(legacyBinDir, "sentry"), "legacy-binary");

    const { context, restore } = createMockContext({
      homeDir: testHome,
      env: { SENTRY_INSTALL_DIR: installDir },
    });
    restoreStderr = restore;

    await run(app, setupArgs, context);

    expect(await readFile(join(installDir, "sentry"), "utf8")).toBe(
      "current-binary"
    );
  });

  test("does not migrate a binary out of ~/.local/bin (a valid target)", async () => {
    // ~/.local/bin is a current XDG install target, not a legacy source: a
    // binary there must never be relocated, even if it isn't the resolved dir.
    const installDir = join(testHome, "install", "bin");
    const localBin = join(testHome, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(localBin, "sentry"), "local-binary");

    const { context, restore } = createMockContext({
      homeDir: testHome,
      env: { SENTRY_INSTALL_DIR: installDir },
    });
    restoreStderr = restore;

    await run(app, setupArgs, context);

    // The ~/.local/bin binary stays put; nothing is copied to the target.
    expect(existsSync(join(localBin, "sentry"))).toBe(true);
    expect(await readFile(join(localBin, "sentry"), "utf8")).toBe(
      "local-binary"
    );
    expect(existsSync(join(installDir, "sentry"))).toBe(false);
  });

  test("does not migrate a binary out of ~/bin (a valid target)", async () => {
    const installDir = join(testHome, "install", "bin");
    const homeBin = join(testHome, "bin");
    mkdirSync(homeBin, { recursive: true });
    writeFileSync(join(homeBin, "sentry"), "home-bin-binary");

    const { context, restore } = createMockContext({
      homeDir: testHome,
      env: { SENTRY_INSTALL_DIR: installDir },
    });
    restoreStderr = restore;

    await run(app, setupArgs, context);

    expect(existsSync(join(homeBin, "sentry"))).toBe(true);
    expect(existsSync(join(installDir, "sentry"))).toBe(false);
  });
});

describe("sentry cli setup — legacy migration records new path", () => {
  // Isolate the DB so getInstallInfo() reflects this test's writes.
  useTestConfigDir("test-setup-migration-info-");

  let testHome: string;
  let restoreStderr: (() => void) | undefined;

  beforeEach(() => {
    testHome = join(
      "/tmp",
      `setup-mig-info-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    restoreStderr?.();
    restoreStderr = undefined;
    clearInstallInfo();
    rmSync(testHome, { recursive: true, force: true });
  });

  test("records the migrated binary path, not the legacy location", async () => {
    const installDir = join(testHome, "install", "bin");
    const legacyBinDir = join(testHome, ".sentry", "bin");
    mkdirSync(legacyBinDir, { recursive: true });
    writeFileSync(join(legacyBinDir, "sentry"), "legacy-binary");

    const { context, restore } = createMockContext({
      homeDir: testHome,
      env: {
        SENTRY_INSTALL_DIR: installDir,
        SENTRY_CONFIG_DIR: process.env.SENTRY_CONFIG_DIR,
      },
    });
    restoreStderr = restore;

    await run(
      app,
      [
        "cli",
        "setup",
        "--quiet",
        "--method",
        "curl",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
      ],
      context
    );

    const recorded = getInstallInfo();
    expect(recorded?.path).toBe(join(installDir, "sentry"));
  });
});

describe("sentry cli setup — --channel flag", () => {
  useTestConfigDir("test-setup-channel-");

  let testDir: string;
  let restoreStderr: (() => void) | undefined;

  beforeEach(() => {
    testDir = join(
      "/tmp",
      `setup-channel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    restoreStderr?.();
    restoreStderr = undefined;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("persists 'nightly' channel when --channel nightly is passed", async () => {
    const { context, restore } = createMockContext({ homeDir: testDir });
    restoreStderr = restore;

    expect(getReleaseChannel()).toBe("stable");

    await run(
      app,
      [
        "cli",
        "setup",
        "--channel",
        "nightly",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
      ],
      context
    );

    expect(getReleaseChannel()).toBe("nightly");
  });

  test("persists 'stable' channel when --channel stable is passed", async () => {
    const { context, restore } = createMockContext({ homeDir: testDir });
    restoreStderr = restore;

    await run(
      app,
      [
        "cli",
        "setup",
        "--channel",
        "stable",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
      ],
      context
    );

    expect(getReleaseChannel()).toBe("stable");
  });

  test("logs channel when not in --install mode", async () => {
    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
    });
    restoreStderr = restore;

    await run(
      app,
      [
        "cli",
        "setup",
        "--channel",
        "nightly",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
      ],
      context
    );

    expect(getOutput()).toContain("Recorded release channel: nightly");
  });

  test("does not log channel in --install mode", async () => {
    // In --install mode, the setup is silent about the channel
    // (it's set during binary placement, before user sees output)
    const { context, getOutput, restore } = createMockContext({
      homeDir: testDir,
      execPath: join(testDir, "sentry.download"),
    });
    restoreStderr = restore;

    await run(
      app,
      [
        "cli",
        "setup",
        "--install",
        "--channel",
        "nightly",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
      ],
      context
    );

    expect(getOutput()).not.toContain("Recorded release channel: nightly");
  });
});
