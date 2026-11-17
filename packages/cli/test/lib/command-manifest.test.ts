import { run } from "@stricli/core";
import { afterEach, describe, expect, test } from "vitest";
import { loadAppForArgs } from "../../src/app-for-args.js";
import { app, routes } from "../../src/app.js";
import { COMMAND_MANIFEST } from "../../src/command-manifest.js";
import generatedTopLevelRoutes from "../../src/generated/top-level-routes.json";
import type { SentryContext } from "../../src/context.js";
import type { CliApplication } from "../../src/lib/application.js";
import { withEnv } from "../../src/lib/env.js";
import { printCustomHelp } from "../../src/lib/help.js";
import { setRoutes } from "../../src/lib/route-registry.js";
import { TOP_LEVEL_BRIEFS } from "../../src/top-level-briefs.js";
import { describeTopLevelRoutes } from "../../script/lib/top-level-routes.js";
import { envWithoutAgent, useTestConfigDir } from "../helpers.js";

describe("COMMAND_MANIFEST", () => {
  test("lists every top-level route of app.ts, in its order", () => {
    expect(Object.keys(COMMAND_MANIFEST)).toEqual(
      routes.getAllEntries().map((entry) => entry.name.original),
    );
  });

  test("has a brief in TOP_LEVEL_BRIEFS for each visible route, in order", () => {
    expect(
      Object.entries(COMMAND_MANIFEST)
        .filter(([, entry]) => !entry.hidden)
        .map(([name]) => name),
    ).toEqual(Object.keys(TOP_LEVEL_BRIEFS));
  });

  test("gives each visible route of app.ts its brief", () => {
    // A top-level route sets `brief: topLevelBrief(name)` instead of its own
    const briefs: Record<string, string | undefined> = TOP_LEVEL_BRIEFS;
    for (const entry of routes.getAllEntries()) {
      if (!COMMAND_MANIFEST[entry.name.original]?.hidden) {
        expect(entry.target.brief).toBe(briefs[entry.name.original]);
      }
    }
  });

  test("loads the command or route map app.ts uses", async () => {
    for (const entry of routes.getAllEntries()) {
      expect(await COMMAND_MANIFEST[entry.name.original]?.load()).toBe(
        entry.target,
      );
    }
  });
});

describe("generated/top-level-routes.json", () => {
  test("is what the route tree says", () => {
    // On failure, run `pnpm run generate:top-level-routes`
    expect(generatedTopLevelRoutes).toEqual(
      describeTopLevelRoutes(routes, app.config.documentation),
    );
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
