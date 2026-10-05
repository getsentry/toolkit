/**
 * Tests for `sentry cli uninstall` command.
 *
 * Tests package manager detection, dry-run mode, --keep-config flag,
 * and artifact removal via --yes.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
import {
  clearInstallInfo,
  setInstallInfo,
} from "../../../src/lib/db/install-info.js";
import { useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("uninstall-");

let savedArgv: string[];

beforeEach(() => {
  savedArgv = [...process.argv];
  // Override argv[1] to avoid vitest's node_modules path triggering
  // detectRuntimePackageManager() in every test
  process.argv[1] = "/usr/local/bin/sentry";
});

afterEach(() => {
  process.argv = savedArgv;
  clearInstallInfo();
});

/**
 * Run the uninstall command via Stricli's `run()` and capture stdout.
 *
 * Uses `--yes` or `--dry-run` by default since the non-interactive guard
 * rejects in non-TTY test environments without an explicit bypass flag.
 */
async function runUninstall(
  args: string[]
): Promise<{ output: string; exitCode: number | undefined }> {
  let output = "";
  const mockContext: SentryContext = {
    process: {
      ...process,
      exitCode: undefined,
    } as typeof process,
    env: process.env,
    cwd: process.cwd(),
    homeDir: "/tmp",
    configDir: "/tmp",
    stdout: {
      write(data: string | Uint8Array) {
        output +=
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return true;
      },
    },
    stderr: {
      write() {
        return true;
      },
    },
    stdin: process.stdin,
  };

  await run(app, ["cli", "uninstall", ...args], mockContext);
  return { output, exitCode: mockContext.process.exitCode };
}

describe("sentry cli uninstall", () => {
  test("--dry-run shows what would be removed", async () => {
    const { output } = await runUninstall(["--dry-run"]);
    expect(output).toContain("Dry run");
    expect(output).toContain("config directory");
  });

  test("detects npm install and suggests npm uninstall", async () => {
    setInstallInfo({
      method: "npm",
      path: "/usr/local/bin/sentry",
      version: "1.0.0",
    });

    const { output } = await runUninstall(["--yes"]);
    expect(output).toContain("npm uninstall -g sentry");
  });

  test("detects brew install and suggests brew uninstall", async () => {
    setInstallInfo({
      method: "brew",
      path: "/opt/homebrew/bin/sentry",
      version: "1.0.0",
    });

    const { output } = await runUninstall(["--yes"]);
    expect(output).toContain("brew uninstall getsentry/tools/sentry");
  });

  test("detects pnpm install and suggests pnpm remove", async () => {
    setInstallInfo({
      method: "pnpm",
      path: "/usr/local/bin/sentry",
      version: "1.0.0",
    });

    const { output } = await runUninstall(["--yes"]);
    expect(output).toContain("pnpm remove -g sentry");
  });

  test("--yes removes config directory without prompting", async () => {
    const configDir = getConfigDir();
    expect(existsSync(configDir)).toBe(true);

    const { output } = await runUninstall(["--yes"]);
    expect(output).toContain("Removed");
    expect(output).toContain("config directory");
  });

  test("--keep-config preserves config directory", async () => {
    const configDir = getConfigDir();
    expect(existsSync(configDir)).toBe(true);

    await runUninstall(["--yes", "--keep-config"]);
    // Config dir should still exist
    expect(existsSync(configDir)).toBe(true);
  });

  test("--force works as alternative to --yes", async () => {
    const configDir = getConfigDir();
    expect(existsSync(configDir)).toBe(true);

    const { output } = await runUninstall(["--force"]);
    expect(output).toContain("Removed");
    expect(output).toContain("config directory");
  });

  test("shows nothing to uninstall when no artifacts exist", async () => {
    // First run removes the config dir
    await runUninstall(["--yes"]);

    // Second run should find nothing
    const { output } = await runUninstall(["--yes"]);
    expect(output).toContain("Skipped");
  });

  test("--json outputs structured data", async () => {
    const { output } = await runUninstall(["--dry-run", "--json"]);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("dryRun", true);
    expect(parsed).toHaveProperty("removed");
    expect(parsed).toHaveProperty("skipped");
    expect(parsed).toHaveProperty("failed");
    expect(Array.isArray(parsed.removed)).toBe(true);
  });
});

describe("removeSentryLinesFromConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    tempDir = await mkdtemp(join(tmpdir(), "uninstall-config-"));
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tempDir, { recursive: true, force: true });
  });

  test("removes single # sentry block", async () => {
    const { removeSentryLinesFromConfig } = await import(
      "../../../src/commands/cli/uninstall.js"
    );

    const configFile = join(tempDir, ".bashrc");
    await writeFile(
      configFile,
      '# existing\nexport FOO=bar\n\n# sentry\nexport PATH="/home/.sentry/bin:$PATH"\n\nalias ll="ls -la"\n',
      "utf-8"
    );

    const result = await removeSentryLinesFromConfig(configFile);
    expect(result).toBe(true);

    const content = await readFile(configFile, "utf-8");
    expect(content).not.toContain("# sentry");
    expect(content).not.toContain(".sentry/bin");
    expect(content).toContain("# existing");
    expect(content).toContain("alias ll");
  });

  test("removes multiple # sentry blocks from same file", async () => {
    const { removeSentryLinesFromConfig } = await import(
      "../../../src/commands/cli/uninstall.js"
    );

    const configFile = join(tempDir, ".zshrc");
    await writeFile(
      configFile,
      [
        "# existing",
        "",
        "# sentry",
        'export PATH="/home/.sentry/bin:$PATH"',
        "",
        "# sentry",
        'fpath=("/home/.local/share/zsh/site-functions" $fpath)',
        "",
        "alias ll='ls -la'",
        "",
      ].join("\n"),
      "utf-8"
    );

    const result = await removeSentryLinesFromConfig(configFile);
    expect(result).toBe(true);

    const content = await readFile(configFile, "utf-8");
    expect(content).not.toContain("# sentry");
    expect(content).not.toContain(".sentry/bin");
    expect(content).not.toContain("fpath=");
    expect(content).toContain("# existing");
    expect(content).toContain("alias ll");
  });

  test("does not remove # sentry-wizard or similar", async () => {
    const { removeSentryLinesFromConfig } = await import(
      "../../../src/commands/cli/uninstall.js"
    );

    const configFile = join(tempDir, ".bashrc");
    await writeFile(
      configFile,
      "# sentry-wizard config\nexport WIZARD=true\n",
      "utf-8"
    );

    const result = await removeSentryLinesFromConfig(configFile);
    expect(result).toBe(false);

    const content = await readFile(configFile, "utf-8");
    expect(content).toContain("# sentry-wizard");
    expect(content).toContain("WIZARD=true");
  });

  test("returns false when no sentry entries exist", async () => {
    const { removeSentryLinesFromConfig } = await import(
      "../../../src/commands/cli/uninstall.js"
    );

    const configFile = join(tempDir, ".bashrc");
    await writeFile(
      configFile,
      "# just a normal config\nexport FOO=bar\n",
      "utf-8"
    );

    const result = await removeSentryLinesFromConfig(configFile);
    expect(result).toBe(false);
  });
});
