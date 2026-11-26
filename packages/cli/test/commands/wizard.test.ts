/**
 * Tests for `sentry wizard`: integration selection, the flags it passes to a
 * wizard flow, and how a stopped wizard sets the exit code.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { runNextjsWizard } = vi.hoisted(() => ({
  runNextjsWizard: vi.fn<(options: unknown) => Promise<void>>(),
}));
vi.mock("../../src/lib/wizard/nextjs/nextjs-wizard.js", () => ({
  runNextjsWizard,
}));

import { wizardCommand } from "../../src/commands/wizard.js";
import type { SentryContext } from "../../src/context.js";
import { ValidationError, WizardExitError } from "../../src/lib/errors.js";
import type { Writer } from "../../src/types/index.js";
import { loadCommand, useTestConfigDir } from "../helpers.js";

useTestConfigDir("wizard-test-");

const DEFAULT_FLAGS = {
  saas: false,
  debug: false,
  spotlight: false,
  "disable-telemetry": false,
  "force-install": false,
  "ignore-git-changes": false,
  signup: false,
  "skip-connect": false,
  quiet: false,
  uninstall: false,
};

async function runWizardCommand(
  flags: Record<string, unknown> = {},
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
  await func.call(context, { ...DEFAULT_FLAGS, ...flags });
}

beforeEach(() => {
  runNextjsWizard.mockReset();
  runNextjsWizard.mockResolvedValue(undefined);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("sentry wizard", () => {
  test("runs the -i integration with the @sentry/wizard flags", async () => {
    await runWizardCommand({
      integration: "nextjs",
      org: "acme",
      project: "web",
      url: "https://sentry.example.com",
      spotlight: true,
      "force-install": true,
      "ignore-git-changes": true,
      "disable-telemetry": true,
    });

    expect(runNextjsWizard).toHaveBeenCalledWith({
      telemetryEnabled: false,
      url: "https://sentry.example.com",
      orgSlug: "acme",
      projectSlug: "web",
      saas: false,
      forceInstall: true,
      ignoreGitChanges: true,
      spotlight: true,
    });
  });

  test.each([
    [{ signup: true }, "--signup is no longer supported."],
    [{ "promo-code": "PROMO" }, "--promo-code is no longer supported."],
    [{ "coming-from": "vercel" }, "--coming-from is no longer supported."],
    [
      { signup: true, "promo-code": "PROMO" },
      "--signup, --promo-code are no longer supported.",
    ],
  ])("rejects the removed sign-up flags %o", async (flags, message) => {
    const error = await runWizardCommand({ integration: "nextjs", ...flags })
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain(message);
    expect((error as ValidationError).message).toContain(
      "https://sentry.io/signup/",
    );
    expect(runNextjsWizard).not.toHaveBeenCalled();
  });

  test("reads the integration and URL from SENTRY_WIZARD_* variables", async () => {
    vi.stubEnv("SENTRY_WIZARD_INTEGRATION", "nextjs");
    vi.stubEnv("SENTRY_WIZARD_URL", "https://self-hosted.example.com");

    await runWizardCommand();

    expect(runNextjsWizard).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://self-hosted.example.com" }),
    );
  });

  test("rejects an unknown SENTRY_WIZARD_INTEGRATION", async () => {
    vi.stubEnv("SENTRY_WIZARD_INTEGRATION", "cobol");

    await expect(runWizardCommand()).rejects.toThrow(ValidationError);
    expect(runNextjsWizard).not.toHaveBeenCalled();
  });

  test("reports an integration this version can't set up yet", async () => {
    await expect(runWizardCommand({ integration: "remix" })).rejects.toThrow(
      "The remix wizard is not available in this version yet.",
    );
  });

  test("exits with the wizard's code when it stops", async () => {
    runNextjsWizard.mockRejectedValue(new WizardExitError(0));

    await runWizardCommand({ integration: "nextjs" });

    expect(process.exitCode).toBe(0);
  });

  test("exits with code 1 when the wizard can't continue", async () => {
    runNextjsWizard.mockRejectedValue(new WizardExitError(1));

    await runWizardCommand({ integration: "nextjs" });

    expect(process.exitCode).toBe(1);
  });
});
