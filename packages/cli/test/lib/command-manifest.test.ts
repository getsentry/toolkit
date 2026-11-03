import { run } from "@stricli/core";
import { afterEach, describe, expect, test } from "vitest";
import { loadAppForArgs } from "../../src/app-for-args.js";
import { app, routes } from "../../src/app.js";
import { COMMAND_MANIFEST } from "../../src/command-manifest.js";
import type { SentryContext } from "../../src/context.js";
import type { CliApplication } from "../../src/lib/application.js";
import { withEnv } from "../../src/lib/env.js";
import { printCustomHelp } from "../../src/lib/help.js";
import {
  getPositionalString,
  isCommand,
  isRouteMap,
  type RouteMapEntry,
} from "../../src/lib/introspect.js";
import { setRoutes } from "../../src/lib/route-registry.js";
import { envWithoutAgent, useTestConfigDir } from "../helpers.js";

/** The usage config Stricli formats `sentry --help` with. */
const USAGE_CONFIG = app.config.documentation;

/**
 * What `COMMAND_MANIFEST` should say about a top-level route of `app.ts`,
 * without its loader.
 */
function describeRoute(entry: RouteMapEntry): Record<string, unknown> {
  if (entry.hidden) {
    return { hidden: true };
  }
  const { target } = entry;
  if (isRouteMap(target)) {
    return {
      brief: target.brief,
      subcommands: target
        .getAllEntries()
        .filter((sub) => !sub.hidden)
        .map((sub) => sub.name.original),
    };
  }
  if (!isCommand(target)) {
    throw new Error(`Route ${entry.name.original} is neither kind`);
  }
  const prefix = `sentry ${entry.name.original}`;
  const usageLine = (
    target as unknown as {
      formatUsageLine: (args: unknown) => string;
    }
  ).formatUsageLine({ prefix: prefix.split(" "), config: USAGE_CONFIG });
  const placeholder =
    target.__primaryUsage ?? getPositionalString(target.parameters.positional);
  return {
    brief: target.brief,
    usage: usageLine.slice(prefix.length + 1),
    ...(placeholder ? { placeholder } : {}),
  };
}

describe("COMMAND_MANIFEST", () => {
  test("lists every top-level route of app.ts, in its order", () => {
    expect(Object.keys(COMMAND_MANIFEST)).toEqual(
      routes.getAllEntries().map((entry) => entry.name.original),
    );
  });

  test("says what app.ts's routes show in help", () => {
    const manifest = Object.fromEntries(
      Object.entries(COMMAND_MANIFEST).map(([name, { load, ...entry }]) => [
        name,
        entry,
      ]),
    );
    const actual = Object.fromEntries(
      routes
        .getAllEntries()
        .map((entry) => [entry.name.original, describeRoute(entry)]),
    );
    // On failure, copy the entries from the expected side into the manifest
    expect(manifest).toEqual(actual);
  });

  test("loads the command or route map app.ts uses", async () => {
    for (const entry of routes.getAllEntries()) {
      expect(await COMMAND_MANIFEST[entry.name.original]?.load()).toBe(
        entry.target,
      );
    }
  });
});

/**
 * What `sentry --help` prints with `app`, with or without ANSI colors.
 *
 * Stricli colors help when the stream's color depth is at least 4.
 */
async function renderUsage(
  application: CliApplication,
  ansiColor: boolean,
): Promise<string> {
  let output = "";
  const stream = {
    write: (chunk: string) => {
      output += chunk;
    },
    getColorDepth: () => (ansiColor ? 8 : 1),
  };
  const context = { process: { stdout: stream, stderr: stream, env: {} } };
  await run(application, ["--help"], context as unknown as SentryContext);
  return output;
}

describe("top-level help from the manifest", () => {
  useTestConfigDir("command-manifest-test-");

  afterEach(() => {
    setRoutes(routes);
  });

  test.each([{ overview: true }, { overview: false }])(
    "printCustomHelp(%j) prints what the full application does",
    async (options) => {
      const full = withEnv(envWithoutAgent(), () => {
        setRoutes(routes);
        return printCustomHelp(options);
      });
      const loaded = await loadAppForArgs(["help"]);
      expect(loaded.routes).not.toBe(routes);
      expect(withEnv(envWithoutAgent(), () => printCustomHelp(options))).toBe(
        full,
      );
    },
  );

  test.each([false, true])(
    "`--help` prints what the full application does (ansiColor: %s)",
    async (ansiColor) => {
      const full = await renderUsage(app, ansiColor);
      const loaded = await loadAppForArgs(["--help"]);
      expect(loaded.routes).not.toBe(routes);
      expect(await renderUsage(loaded.app, ansiColor)).toBe(full);
    },
  );

  test("loads only the help command", async () => {
    const loaded = await loadAppForArgs([]);
    const help = loaded.routes.getRoutingTargetForInput("help");
    expect(help).toBe(routes.getRoutingTargetForInput("help"));
    for (const entry of loaded.routes.getAllEntries()) {
      if (entry.name.original !== "help") {
        expect(entry.target).not.toBe(
          routes.getRoutingTargetForInput(entry.name.original),
        );
      }
    }
  });
});
