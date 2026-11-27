/**
 * Tests for `sentry wizard`: its command line (`[<org>/<project>]
 * [<integration>]` and `--force`, nothing else), what it passes to a wizard
 * flow, and how a stopped wizard sets the exit code.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { runNextjsWizard, isTelemetryEnabled } = vi.hoisted(() => ({
  runNextjsWizard: vi.fn<(options: unknown) => Promise<void>>(),
  isTelemetryEnabled: vi.fn<() => boolean>(),
}));
vi.mock("../../src/lib/wizard/nextjs/nextjs-wizard.js", () => ({
  runNextjsWizard,
}));
vi.mock("../../src/lib/telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/telemetry.js")>()),
  isTelemetryEnabled,
}));

import {
  parseWizardArguments,
  wizardCommand,
} from "../../src/commands/wizard.js";
import type { SentryContext } from "../../src/context.js";
import { buildCommand } from "../../src/lib/command.js";
import { ValidationError, WizardExitError } from "../../src/lib/errors.js";
import { hasWizardRunner, INTEGRATION_IDS } from "../../src/lib/wizard/run.js";
import type { Writer } from "../../src/types/index.js";
import { loadCommand, useTestConfigDir } from "../helpers.js";

useTestConfigDir("wizard-test-");

async function runWizardCommand(
  flags: Record<string, unknown> = {},
  ...args: string[]
): Promise<void> {
  const context = {
    process,
    env: process.env,
    stdout: { write: vi.fn<Writer["write"]>(() => true) },
    stderr: { write: vi.fn<Writer["write"]>(() => true) },
    stdin: process.stdin,
    cwd: "/tmp",
    homeDir: "/tmp",
    configDir: "/tmp",
  } as unknown as SentryContext;
  const func = await loadCommand(wizardCommand);
  await func.call(context, { force: false, ...flags }, ...args);
}

/** The options the Next.js flow was called with. */
function nextjsOptions(): Record<string, unknown> {
  expect(runNextjsWizard).toHaveBeenCalledTimes(1);
  return runNextjsWizard.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  runNextjsWizard.mockReset();
  runNextjsWizard.mockResolvedValue(undefined);
  isTelemetryEnabled.mockReset();
  isTelemetryEnabled.mockReturnValue(true);
  vi.stubEnv("SENTRY_SPOTLIGHT", "");
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("sentry wizard flags", () => {
  /** Flags and aliases `buildCommand` adds to every command. */
  const injected = buildCommand({
    auth: false,
    docs: { brief: "probe" },
    parameters: {},
    // oxlint-disable-next-line require-yield -- A probe; it never runs.
    async *func() {
      await Promise.resolve();
    },
  }).parameters;

  test("--force (-f) is the wizard's only flag, and it is not hidden", () => {
    const { flags = {}, aliases = {} } = wizardCommand.parameters as {
      flags?: Record<string, { hidden?: boolean }>;
      aliases?: Record<string, string>;
    };
    const ownFlags = Object.keys(flags).filter(
      (name) => !(name in (injected.flags ?? {})),
    );
    const ownAliases = Object.entries(aliases).filter(
      ([alias]) => !(alias in (injected.aliases ?? {})),
    );

    expect(ownFlags).toEqual(["force"]);
    expect(flags["force"]?.hidden).toBeUndefined();
    expect(Object.fromEntries(ownAliases)).toEqual({ f: "force" });
  });
});

describe("parseWizardArguments", () => {
  test("no arguments: the user picks the integration and the project", () => {
    expect(parseWizardArguments([])).toEqual({
      target: { type: "auto-detect" },
    });
  });

  test("an integration alone", () => {
    expect(parseWizardArguments(["nextjs"])).toEqual({
      target: { type: "auto-detect" },
      integration: "nextjs",
    });
  });

  test("a target alone", () => {
    expect(parseWizardArguments(["my-org/my-project"])).toEqual({
      target: { type: "explicit", org: "my-org", project: "my-project" },
    });
    expect(parseWizardArguments(["my-org/"])).toEqual({
      target: { type: "org-all", org: "my-org" },
    });
    expect(parseWizardArguments(["/my-project"])).toEqual({
      target: { type: "project-search", projectSlug: "my-project" },
    });
  });

  test("a target, then an integration", () => {
    expect(parseWizardArguments(["my-org/my-project", "nextjs"])).toEqual({
      target: { type: "explicit", org: "my-org", project: "my-project" },
      integration: "nextjs",
    });
  });

  test("a bare project or org slug before an integration is the target", () => {
    expect(parseWizardArguments(["my-project", "nextjs"])).toEqual({
      target: { type: "project-search", projectSlug: "my-project" },
      integration: "nextjs",
    });
  });

  test("a bare slug alone is read as an integration, so it must be one", () => {
    expect(() => parseWizardArguments(["my-project"])).toThrow(
      new ValidationError(
        "Unknown integration 'my-project'. Pick one of: reactNative, flutter, ios, appleSnapshots, angular, android, nextjs, nuxt, remix, reactRouter, sveltekit, cloudflare, sourcemaps.\n" +
          "  To name an org or project instead, write it as <org>/<project>, <org>/ or /<project>.\n" +
          "  Usage: sentry wizard [<org>/<project>] [<integration>]",
        "integration",
      ),
    );
  });

  test("a project named like an integration is written with its org", () => {
    expect(parseWizardArguments(["my-org/nextjs"])).toEqual({
      target: { type: "explicit", org: "my-org", project: "nextjs" },
    });
    expect(parseWizardArguments(["my-org/nextjs", "nextjs"])).toEqual({
      target: { type: "explicit", org: "my-org", project: "nextjs" },
      integration: "nextjs",
    });
    expect(parseWizardArguments(["/nextjs"])).toEqual({
      target: { type: "project-search", projectSlug: "nextjs" },
    });
  });

  test("an unknown integration after a target", () => {
    expect(() => parseWizardArguments(["my-org/my-project", "cobol"])).toThrow(
      "Unknown integration 'cobol'.",
    );
  });

  test("integration ids are matched exactly", () => {
    expect(() => parseWizardArguments(["NextJS"])).toThrow(
      "Unknown integration 'NextJS'.",
    );
    expect(() => parseWizardArguments(["nextjs,remix"])).toThrow(
      "Unknown integration 'nextjs,remix'.",
    );
  });

  test("exactly one integration", () => {
    expect(() => parseWizardArguments(["nextjs", "remix"])).toThrow(
      "'nextjs' is an integration, and the wizard sets up one at a time.\n" +
        "  To name a project or org called 'nextjs', write it as <org>/nextjs, nextjs/ or /nextjs.",
    );
  });

  test("too many arguments", () => {
    expect(() =>
      parseWizardArguments(["my-org/my-project", "nextjs", "remix"]),
    ).toThrow(
      "Too many arguments: remix. Expected: sentry wizard [<org>/<project>] [<integration>]",
    );
  });
});

describe("sentry wizard", () => {
  test("runs the integration for the target", async () => {
    await runWizardCommand({}, "my-org/my-project", "nextjs");

    expect(nextjsOptions()).toEqual({
      telemetryEnabled: true,
      target: { type: "explicit", org: "my-org", project: "my-project" },
      forceInstall: false,
      ignoreGitChanges: false,
      spotlight: false,
    });
  });

  test("--force both force-installs and skips the uncommitted changes prompt", async () => {
    await runWizardCommand({ force: true }, "nextjs");

    expect(nextjsOptions()).toMatchObject({
      forceInstall: true,
      ignoreGitChanges: true,
    });
  });

  test.each([
    ["1", true],
    ["true", true],
    ["http://localhost:8969/stream", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["", false],
  ])("SENTRY_SPOTLIGHT=%j sets Spotlight mode to %s", async (value, on) => {
    vi.stubEnv("SENTRY_SPOTLIGHT", value);

    await runWizardCommand({}, "nextjs");

    expect(nextjsOptions()).toMatchObject({ spotlight: on });
  });

  test.each([true, false])(
    "telemetry follows isTelemetryEnabled() (%s)",
    async (enabled) => {
      isTelemetryEnabled.mockReturnValue(enabled);

      await runWizardCommand({}, "nextjs");

      expect(nextjsOptions()).toMatchObject({ telemetryEnabled: enabled });
    },
  );

  const unported = INTEGRATION_IDS.find((id) => !hasWizardRunner(id));

  test.runIf(unported)(
    "reports an integration this version can't set up yet",
    async () => {
      await expect(runWizardCommand({}, unported ?? "")).rejects.toThrow(
        `The ${unported} wizard is not available in this version yet.`,
      );
    },
  );

  test("exits with the wizard's code when it stops", async () => {
    runNextjsWizard.mockRejectedValue(new WizardExitError(0));

    await runWizardCommand({}, "nextjs");

    expect(process.exitCode).toBe(0);
  });

  test("exits with code 1 when the wizard can't continue", async () => {
    runNextjsWizard.mockRejectedValue(new WizardExitError(1));

    await runWizardCommand({}, "nextjs");

    expect(process.exitCode).toBe(1);
  });
});
