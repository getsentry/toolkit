/**
 * Integration tests for top-level flag handling by Stricli's patched route
 * scanner and application runner.
 *
 * The `@stricli/core` patch (see
 * `packages/cli/patches/@stricli%2Fcore@1.2.8.patch`) teaches `buildRouteScanner`
 * to accept a fixed allow-list of Sentry global flags (`--verbose`, `--json`,
 * `--org`, `--project`, `--log-level`, `--fields`, and the `-v` alias) at any
 * route depth, forwarding them to the leaf command instead of failing route
 * resolution. It also recognizes `--version` at any depth (printing the version
 * from `runApplication`) and exposes a `documentation.renderHelp` hook that the
 * app uses to render `--help --json` as structured JSON. Together these replace
 * the old `argv-glue`/`argv-hoist` preprocessors.
 *
 * These tests exercise the real `app` end-to-end via `run()` so the patch —
 * not a preprocessor — is what makes `sentry --verbose bash-hook`,
 * `sentry cli --version`, and `sentry issue list --help --json` behave.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { describe, expect, test } from "vitest";
import { app } from "../../src/app.js";
import type { SentryContext } from "../../src/context.js";
import { CLI_VERSION } from "../../src/lib/constants.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("scanner-flags-integration-");

// Empty working dir so any command that reaches target resolution finds no DSNs
// to auto-detect and fails fast instead of making real network calls. Routing
// has already happened by then, which is all these tests assert.
const emptyCwd = mkdtempSync(join(tmpdir(), "scanner-flags-cwd-"));

/** Run the real app with a mock context, capturing stdout and stderr. */
async function runApp(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const captureStderr = {
    write(data: string | Uint8Array) {
      stderr +=
        typeof data === "string" ? data : new TextDecoder().decode(data);
      return true;
    },
  };
  const context: SentryContext = {
    process: {
      ...process,
      // Route the underlying process streams into our buffers too — Stricli's
      // argument-scanner errors write to context.process.stderr, not context.stderr.
      stdout: {
        write(data: string | Uint8Array) {
          stdout +=
            typeof data === "string" ? data : new TextDecoder().decode(data);
          return true;
        },
      },
      stderr: captureStderr,
      exitCode: undefined,
    } as unknown as typeof process,
    env: { ...process.env },
    cwd: emptyCwd,
    homeDir: "/tmp",
    configDir: "/tmp",
    stdout: {
      write(data: string | Uint8Array) {
        stdout +=
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return true;
      },
    },
    stderr: captureStderr,
    stdin: process.stdin,
  };

  const exitCode = await run(app, args, context);
  return { stdout, stderr, exitCode: exitCode ?? 0 };
}

/**
 * Stricli's error message when the route scanner treats a token as an unknown
 * subcommand — the failure mode the patch fixes for global flags at depth.
 */
const NO_COMMAND_REGISTERED = "No command registered";

describe("top-level flags on a leaf command (bash-hook, no auth)", () => {
  // bash-hook runs without auth and emits its script to stdout, so a successful
  // route + execution is observable regardless of where the global flag sits.

  test("--verbose before the command still runs it", async () => {
    const { stdout, stderr } = await runApp(["--verbose", "bash-hook"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toContain("_sentry_err_trap");
  });

  test("-v (verbose alias) before the command runs it, not `--version`", async () => {
    // The patch drops Stricli's built-in `-v`=version alias, so `-v` stays the
    // Sentry CLI's --verbose alias and reaches the leaf command via the scanner.
    const { stdout, stderr } = await runApp(["-v", "bash-hook"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toContain("_sentry_err_trap");
    // Not the bare version string.
    expect(stdout).not.toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--log-level with a value before the command still runs it", async () => {
    const { stdout, stderr } = await runApp([
      "--log-level",
      "debug",
      "bash-hook",
    ]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toContain("_sentry_err_trap");
  });

  test("a value flag's value is not mistaken for the command", async () => {
    // `--org acme` must consume `acme` as the flag value, leaving `bash-hook`
    // as the route. A naive scanner would treat `acme` as the subcommand.
    const { stdout, stderr } = await runApp(["--org", "acme", "bash-hook"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toContain("_sentry_err_trap");
  });

  test("--org=acme inline form before the command still runs it", async () => {
    const { stdout, stderr } = await runApp(["--org=acme", "bash-hook"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toContain("_sentry_err_trap");
  });

  test("the command's own flags still parse alongside a global flag", async () => {
    const { stdout, stderr } = await runApp([
      "--verbose",
      "bash-hook",
      "--release",
      "1.0.0",
    ]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toContain("--release '1.0.0'");
  });
});

describe("top-level flags on a nested group command", () => {
  // `cli defaults` is a no-auth, no-network group subcommand, so routing through
  // the `cli` route map to the `defaults` leaf is observable without side effects.
  // The patch is what lets a global flag between (or before) the group and
  // subcommand resolve; without it the scanner rejects it as an unknown route.

  test("--verbose between group and subcommand resolves the route", async () => {
    const { stderr } = await runApp(["cli", "--verbose", "defaults"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
  });

  test("--verbose before the group resolves the route", async () => {
    const { stderr } = await runApp(["--verbose", "cli", "defaults"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
  });

  test("a value flag between group and subcommand does not break routing", async () => {
    // `cli --org acme defaults`: `acme` is the --org value, `defaults` the
    // subcommand — not a route segment.
    const { stderr } = await runApp(["cli", "--org", "acme", "defaults"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
  });
});

describe("a value flag does not swallow --help", () => {
  // A value-taking global flag given without its value (`--org --help`) must not
  // consume the following `--help` as its value — help should still fire, matching
  // Stricli's leaf-level behavior where a following flag isn't taken as a value.
  test("--org --help renders help instead of eating --help", async () => {
    const { stdout, stderr } = await runApp(["--org", "--help"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toContain("USAGE");
  });

  test("--org --help at a group renders help", async () => {
    const { stdout, stderr } = await runApp(["cli", "--org", "--help"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toContain("USAGE");
  });

  test.each([
    "--json",
    "-v",
  ])("%s after a missing value flag still reaches the leaf command", async (flag) => {
    const { stderr } = await runApp(["--org", flag, "issue", "list"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
  });
});

describe("escape sequence is still respected", () => {
  test("a global flag after -- is not treated as a top-level flag", async () => {
    // After `--`, tokens are positional/pass-through. `bash-hook` takes no
    // positionals, so Stricli reports too-many-arguments — proving `--verbose`
    // was NOT consumed as a global flag by the scanner (which would have made
    // the command run cleanly).
    const { stdout, stderr } = await runApp(["bash-hook", "--", "--verbose"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stderr.toLowerCase()).toContain("too many arguments");
    expect(stdout).not.toContain("_sentry_err_trap");
  });
});

describe("--version at any route depth", () => {
  // Stricli only prints `--version` when it is the very first token. The patch
  // adds a `versionRequested` scanner state so `--version` at any depth (before
  // a `--` escape) prints the version from runApplication.
  const versionLine = `${CLI_VERSION}\n`;

  test("top-level --version prints the version", async () => {
    const { stdout } = await runApp(["--version"]);
    expect(stdout).toBe(versionLine);
  });

  test("--version after a route group prints the version", async () => {
    const { stdout, stderr } = await runApp(["cli", "--version"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toBe(versionLine);
  });

  test("--version after a nested subcommand prints the version", async () => {
    const { stdout, stderr } = await runApp(["issue", "list", "--version"]);
    expect(stderr).not.toContain(NO_COMMAND_REGISTERED);
    expect(stdout).toBe(versionLine);
  });

  test("a value flag without its value does not swallow --version", async () => {
    // `--org --version`: `--version` must print the version, not be consumed as
    // the value of `--org` (mirrors the `--org --help` behavior).
    const { stdout } = await runApp(["--org", "--version"]);
    expect(stdout).toBe(versionLine);
  });

  test("--version after a -- escape is left for the wrapped command", async () => {
    // bash-hook takes no positionals, so a `--version` past `--` triggers a
    // too-many-arguments error instead of printing the CLI version.
    const { stdout, stderr } = await runApp(["bash-hook", "--", "--version"]);
    expect(stdout).not.toBe(versionLine);
    expect(stderr.toLowerCase()).toContain("too many arguments");
  });
});

describe("--help --json renders structured help via renderHelp hook", () => {
  // The patch exposes a `documentation.renderHelp` hook; app.ts uses it to emit
  // structured JSON (identical to `sentry help --json`) for `--help --json`,
  // instead of Stricli's text usage.

  test("top-level --help --json emits the full command tree as JSON", async () => {
    const { stdout } = await runApp(["--help", "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("routes");
    expect(parsed).toHaveProperty("flags");
    expect(Array.isArray(parsed.routes)).toBe(true);
  });

  test("command --help --json emits that command's metadata as JSON", async () => {
    const { stdout } = await runApp(["issue", "list", "--help", "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("path");
    expect(parsed.path).toContain("issue list");
  });

  test("--json --help order-insensitive still emits JSON", async () => {
    const { stdout } = await runApp(["--json", "issue", "list", "--help"]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("path");
    expect(parsed.path).toContain("issue list");
  });

  test("--fields narrows the JSON help output", async () => {
    const { stdout } = await runApp([
      "issue",
      "list",
      "--help",
      "--json",
      "--fields",
      "path",
    ]);
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed)).toEqual(["path"]);
  });

  test("bare --help (no --json) still renders text usage", async () => {
    const { stdout } = await runApp(["issue", "list", "--help"]);
    expect(stdout).toContain("USAGE");
    expect(() => JSON.parse(stdout)).toThrow();
  });

  test("an unknown subcommand under a group emits a JSON error, not the group", async () => {
    // `issue` has a default command, so the scanner forwards `nope` to it and
    // reaches renderHelp. The unknown token must surface as a JSON `error`
    // rather than silently rendering the `issue` group.
    const { stdout } = await runApp(["issue", "nope", "--help", "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("error");
    expect(parsed.error).toContain("nope");
  });

  test("a top-level unknown command emits a JSON error", async () => {
    const { stdout } = await runApp(["nope", "--help", "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("error");
    expect(parsed.error).toContain("nope");
  });
});
