/**
 * `sentry <group> help` shows the group's help for every command group.
 *
 * Stricli hands a trailing `help` to the group's default command. A default
 * that takes no positionals (`auth`, `status`, `local`) would fail with "Too
 * many arguments", so `runCli` rewrites those requests to `sentry help
 * <group>`. A default that takes a positional runs first, because `help` may
 * name a real resource, and help shows only when it fails. This walks the
 * whole route tree so a new group cannot break either path.
 *
 * Each case runs the CLI from a fresh module graph, as a real process does:
 * a run registers the routes it loads, and a cached `app.ts` would not
 * register the full tree again for the next run.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { routes } from "../../src/app.js";
import { isRouteMap, publicTargetPaths } from "../../src/lib/introspect.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

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
let apiRequests: string[] = [];
const originalFetch = globalThis.fetch;

function capture(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
}

beforeEach(() => {
  stdout = "";
  stderr = "";
  apiRequests = [];
  process.exitCode = undefined;
  // Commands that run with `help` as a positional resolve it against the API.
  // A 404 makes them fail fast, so the help fallback runs.
  globalThis.fetch = mockFetch(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/api/0/")) {
      apiRequests.push(url);
    }
    return new Response(JSON.stringify({ detail: "Not found" }), {
      status: 404,
    });
  });
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
  globalThis.fetch = originalFetch;
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

  test("runs a default that takes a positional before showing help", async () => {
    // `help` could be a project slug, so `project view help` runs first.
    await runFresh(["project", "help"]);

    expect(apiRequests.length).toBeGreaterThan(0);
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain("sentry project");
    expect(stderr).toContain("sentry project --help");
  });

  test("rewrites without running a default that takes no positionals", async () => {
    await runFresh(["auth", "help"]);

    expect(apiRequests).toEqual([]);
    expect(stdout).toContain("sentry auth");
  });

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

  test.each([
    ["before the group", ["--json", "auth", "help"]],
    ["between the group and help", ["auth", "--json", "help"]],
    [
      "between nested groups",
      ["local", "--org", "acme", "daemon", "--json", "help"],
    ],
  ])("keeps global flags %s", async (_label, args) => {
    await runFresh(args);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr).not.toContain("Too many arguments");
    expect(JSON.parse(stdout)).toHaveProperty("name");
  });
});
