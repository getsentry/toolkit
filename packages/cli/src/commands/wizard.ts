/**
 * sentry wizard
 *
 * Run the interactive setup wizard of a framework or platform: it installs
 * the Sentry SDK, writes its config files, and sets up source map or debug
 * file uploads in the current project. Ported from `@sentry/wizard`, whose
 * `-i <integration>` invocations keep working.
 *
 * The wizard logs in with the CLI's own login instead of the old browser
 * hand-off, so `auth: false` here: a run in Spotlight mode, or with a
 * preselected project, needs no login at all.
 */

import type { SentryContext } from "../context.js";
import { buildCommand } from "../lib/command.js";
import {
  parseOrgSlug,
  parseProjectSlug,
  parseText,
  parseUrl,
} from "../lib/completion-target.js";
import { getEnv } from "../lib/env.js";
import { ValidationError, WizardExitError } from "../lib/errors.js";
import {
  disableTelemetryForRun,
  isTelemetryEnabled,
} from "../lib/telemetry.js";
import { INTEGRATION_IDS, runWizard } from "../lib/wizard/run.js";
import { topLevelBrief } from "../top-level-briefs.js";

type WizardFlags = {
  readonly integration?: string;
  readonly url?: string;
  readonly org?: string;
  readonly project?: string;
  readonly saas: boolean;
  readonly debug: boolean;
  readonly spotlight: boolean;
  readonly "disable-telemetry": boolean;
  readonly "force-install": boolean;
  readonly "ignore-git-changes": boolean;
  readonly signup: boolean;
  readonly "promo-code"?: string;
  readonly "coming-from"?: string;
  readonly "skip-connect": boolean;
  readonly quiet: boolean;
  readonly uninstall: boolean;
};

/**
 * Fail on the `@sentry/wizard` sign-up and partner flags, which `sentry
 * wizard` dropped: it logs in with the CLI's login, which has no sign-up or
 * partner step.
 *
 * @throws {ValidationError} When one of them is passed
 */
function rejectRemovedFlags(flags: WizardFlags): void {
  const removed = [
    flags.signup ? "--signup" : undefined,
    flags["promo-code"] === undefined ? undefined : "--promo-code",
    flags["coming-from"] === undefined ? undefined : "--coming-from",
  ].filter((flag) => flag !== undefined);
  if (removed.length === 0) {
    return;
  }
  throw new ValidationError(
    `${removed.join(", ")} ${removed.length === 1 ? "is" : "are"} no longer supported. ` +
      "Sign up at https://sentry.io/signup/ (and apply any promo code there), " +
      "then run the wizard again without " +
      `${removed.length === 1 ? "it" : "them"}.`,
    removed[0],
  );
}

/** The trimmed value of the environment variable `name`, unless empty. */
function envValue(name: string): string | undefined {
  return getEnv()[name]?.trim() || undefined;
}

export const wizardCommand = buildCommand({
  auth: false,
  docs: {
    brief: topLevelBrief("wizard"),
    fullDescription:
      "Set up Sentry in the project in the current directory. The wizard " +
      "asks you a few questions, installs the Sentry SDK for your framework, " +
      "writes its configuration, and sets up source map or debug file " +
      "uploads. It logs in with your `sentry auth login` account (or starts " +
      "a login), and lets you pick or create the Sentry project to send " +
      "data to.\n\n" +
      "Pass `-i` to skip the integration picker. It takes the same " +
      "integrations and flags as `npx @sentry/wizard`, except the sign-up " +
      "flags `--signup`, `--promo-code` and `--coming-from`, which fail: " +
      "sign up at https://sentry.io/signup/ first.\n\n" +
      "The wizard changes files in your project. To have a coding agent set " +
      "up Sentry instead, run `sentry init`, which prints the agent's setup " +
      "guide and changes nothing.",
    examples: [
      {
        description: "Pick an integration and set it up",
        run: "wizard",
      },
      {
        description: "Set up Next.js for a known org and project on sentry.io",
        run: "wizard -i nextjs --saas --org my-org --project my-project",
      },
      {
        description: "Set up Next.js for Spotlight, without a Sentry account",
        run: "wizard -i nextjs --spotlight",
      },
    ],
  },
  parameters: {
    flags: {
      integration: {
        kind: "enum",
        values: INTEGRATION_IDS,
        brief: "Integration to set up (skips the picker)",
        optional: true,
      },
      url: {
        kind: "parsed",
        parse: parseUrl,
        brief: "URL of your self-hosted Sentry instance",
        placeholder: "url",
        optional: true,
      },
      org: {
        kind: "parsed",
        parse: parseOrgSlug,
        brief: "Slug of the Sentry organization to use",
        placeholder: "org",
        optional: true,
      },
      project: {
        kind: "parsed",
        parse: parseProjectSlug,
        brief: "Slug of the Sentry project to use",
        placeholder: "project",
        optional: true,
      },
      saas: {
        kind: "boolean",
        brief: "Use Sentry SaaS (sentry.io) without asking",
        default: false,
      },
      spotlight: {
        kind: "boolean",
        brief:
          "Set up Spotlight for local development, without a Sentry account",
        default: false,
      },
      "force-install": {
        kind: "boolean",
        brief: "Install the SDK even when the package manager's checks fail",
        default: false,
      },
      "ignore-git-changes": {
        kind: "boolean",
        brief: "Don't ask before changing a project with uncommitted changes",
        default: false,
      },
      "disable-telemetry": {
        kind: "boolean",
        brief: "Don't send telemetry about this run to Sentry",
        default: false,
      },
      debug: {
        kind: "boolean",
        brief: "Print the wizard's debug output",
        default: false,
      },
      // `@sentry/wizard`'s sign-up and partner flags. The wizard logs in
      // with the CLI's login, which has no sign-up or partner step, so these
      // fail with an explanation instead of being dropped silently.
      signup: {
        kind: "boolean",
        brief: "Removed: sign up at https://sentry.io/signup/ first",
        default: false,
        hidden: true as const,
      },
      "promo-code": {
        kind: "parsed",
        parse: parseText,
        brief: "Removed: apply promo codes when you sign up",
        placeholder: "code",
        optional: true,
        hidden: true as const,
      },
      "coming-from": {
        kind: "parsed",
        parse: parseText,
        brief: "Removed: partner sign-up is not supported",
        placeholder: "partner",
        optional: true,
        hidden: true as const,
      },
      // Flags `@sentry/wizard` accepted that no flow reads any more. Kept so
      // copied commands still run.
      "skip-connect": {
        kind: "boolean",
        brief: "Ignored",
        default: false,
        hidden: true as const,
      },
      quiet: {
        kind: "boolean",
        brief: "Ignored",
        default: false,
        hidden: true as const,
      },
      uninstall: {
        kind: "boolean",
        brief: "Ignored: only the retired Cordova wizard could uninstall",
        default: false,
        hidden: true as const,
      },
    },
    aliases: { i: "integration", u: "url", s: "signup" },
  },
  // oxlint-disable-next-line require-yield -- The wizard prints its own interactive output; the command yields none.
  async *func(this: SentryContext, flags: WizardFlags) {
    rejectRemovedFlags(flags);
    if (flags["disable-telemetry"]) {
      disableTelemetryForRun();
    }

    try {
      await runWizard({
        integration: flags.integration ?? envValue("SENTRY_WIZARD_INTEGRATION"),
        debug: flags.debug || envValue("SENTRY_WIZARD_DEBUG") === "true",
        wizardOptions: {
          telemetryEnabled: !flags["disable-telemetry"] && isTelemetryEnabled(),
          url: flags.url ?? envValue("SENTRY_WIZARD_URL"),
          orgSlug: flags.org,
          projectSlug: flags.project,
          saas: flags.saas,
          forceInstall: flags["force-install"],
          ignoreGitChanges: flags["ignore-git-changes"],
          spotlight: flags.spotlight,
        },
      });
    } catch (error) {
      if (!(error instanceof WizardExitError)) {
        throw error;
      }
      // The wizard already explained why it stopped.
      process.exitCode = error.exitCode;
    }
  },
});
