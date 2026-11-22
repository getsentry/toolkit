/**
 * `sentry <group> help` shows the group's help for every command group.
 *
 * `runCli` rewrites a trailing `help` after a group into `sentry help <group>`
 * before dispatch. Without it, Stricli hands `help` to the group's default
 * command, and a default that takes no positionals (`auth`, `status`,
 * `local`) fails with "Too many arguments". This walks the whole route tree
 * so a new group cannot break it again.
 *
 * Each case runs the CLI from a fresh module graph, as a real process does:
 * a run registers the routes it loads, and a cached `app.ts` would not
 * register the full tree again for the next run.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { routes } from "../../src/app.js";
import { isRouteMap, publicTargetPaths } from "../../src/lib/introspect.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("group-help-");

const originalExitCode = process.exitCode;

/** Every public command group path, such as `["auth"]` or `["local", "daemon"]`. */
const groupPaths = [
  ...publicTargetPaths(
    routes as unknown as Parameters<typeof publicTargetPaths>[0],
  ),
]
  .filter(([target]) => isRouteMap(target))
  .map(([, path]) => path);

/** Run the CLI as a new process would. */
async function runFresh(args: string[]): Promise<void> {
  vi.resetModules();
  const { runCli } = await import("../../src/cli.js");
  const { SENTRY_CLI } = await import("../../src/sentry-cli.js");
  await runCli(args, SENTRY_CLI);
}

let stdout = "";
let stderr = "";

function capture(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
}

beforeEach(() => {
  stdout = "";
  stderr = "";
  process.exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += capture(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += capture(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe("sentry <group> help", () => {
  test("covers the groups whose default command takes no positionals", () => {
    const names = groupPaths.map((path) => path.join(" "));
    expect(names).toEqual(
      expect.arrayContaining(["auth", "status", "local", "local daemon"]),
    );
  });

  test.each(groupPaths.map((path) => [path.join(" "), path] as const))(
    "%s help shows the group's help",
    async (name, path) => {
      await runFresh([...path, "help"]);

      expect(process.exitCode ?? 0).toBe(0);
      expect(stdout).toContain(`sentry ${name}`);
      expect(stderr).toContain(`sentry ${name} --help`);
      expect(stderr).not.toContain("Too many arguments");
      expect(stderr).not.toContain("No command registered");
    },
  );

  test("still shows the update notification", async () => {
    vi.resetModules();
    const versionCheck = await import("../../src/lib/version-check.js");
    vi.spyOn(versionCheck, "getUpdateNotification").mockReturnValue(
      "UPDATE AVAILABLE\n",
    );
    const { runCli } = await import("../../src/cli.js");
    const { SENTRY_CLI } = await import("../../src/sentry-cli.js");

    await runCli(["auth", "help"], SENTRY_CLI);

    expect(stderr).toContain("UPDATE AVAILABLE");
  });

  test("keeps global flags before the group", async () => {
    await runFresh(["--json", "auth", "help"]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ name: "auth" });
  });
});
