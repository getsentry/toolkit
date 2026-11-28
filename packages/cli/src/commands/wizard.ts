/**
 * sentry wizard
 *
 * Run the interactive setup wizard of a framework or platform: it installs
 * the Sentry SDK, writes its config files, and sets up source map or debug
 * file uploads in the current project. Ported from `@sentry/wizard`.
 *
 * The wizard logs in with the CLI's own login instead of the old browser
 * hand-off, so `auth: false` here: a run in Spotlight mode needs no login at
 * all.
 */

import type { SentryContext } from "../context.js";
import { sentry } from "../lib/app-identity.js";
import {
  type ParsedOrgProject,
  parseOrgProjectInput,
} from "../lib/arg-parsing.js";
import { buildCommand } from "../lib/command.js";
import { ORG_PROJECT_TARGET, parseText } from "../lib/completion-target.js";
import { getEnv } from "../lib/env.js";
import { ValidationError, WizardExitError } from "../lib/errors.js";
import { parseBoolValue } from "../lib/parse-bool.js";
import {
  type BoundArguments,
  boundArguments,
} from "../lib/positional-parse.js";
import { applySentryUrlContext } from "../lib/sentry-url-parser.js";
import { isTelemetryEnabled } from "../lib/telemetry.js";
import {
  INTEGRATION_IDS,
  runWizard,
  type WizardIntegration,
} from "../lib/wizard/run.js";
import { topLevelBrief } from "../top-level-briefs.js";

const USAGE = "[<org>/<project>] [<integration>]";
const usageHint = () => sentry`wizard ${USAGE}`;

type WizardFlags = {
  readonly force: boolean;
  readonly "app-target"?: string;
  readonly "hosted-test-target"?: string;
};

/** Parsed `sentry wizard` arguments. */
export type WizardInput = {
  /** The org and project to set up; auto-detect means the user picks */
  readonly target: ParsedOrgProject;
  /** Server of a pasted Sentry URL, applied when the arguments resolve */
  readonly baseUrl?: string;
  /** The integration to set up; the user picks when unset */
  readonly integration?: WizardIntegration;
};

/** The arguments of `sentry wizard`. */
export type WizardArguments = BoundArguments<WizardInput, WizardInput>;

/** Whether `value` is exactly one of {@link INTEGRATION_IDS}. */
function isIntegrationId(value: string): value is WizardIntegration {
  return (INTEGRATION_IDS as readonly string[]).includes(value);
}

/**
 * The error for an argument in the integration position that names none.
 *
 * @param hint - Extra line saying how to name a target instead
 */
function unknownIntegration(value: string, hint = ""): ValidationError {
  return new ValidationError(
    `Unknown integration '${value}'. Pick one of: ${INTEGRATION_IDS.join(", ")}.\n` +
      `${hint}  Usage: ${usageHint()}`,
    "integration",
  );
}

/**
 * Parse the positionals of `sentry wizard`: `[<org>/<project>] [<integration>]`.
 * Has no side effects.
 *
 * - No arguments: the user picks both.
 * - One argument: a bare word is the integration. A target always has a `/`
 *   (`<org>/<project>`, `<org>/`, `/<project>`) or is a Sentry URL.
 * - Two arguments: the target, then the integration. The first may be any
 *   target form, including a bare project or org slug, except an
 *   integration id.
 *
 * A bare integration id is never a target, in either position: an org or
 * project spelled like one is written `<org>/nextjs`, `nextjs/` or
 * `/nextjs`.
 *
 * @throws {ValidationError} For more than two arguments, an unknown
 *   integration, two integrations, or a malformed target
 */
export function parseWizardArguments(args: readonly string[]): WizardInput {
  const [first, second, ...extra] = args;
  if (extra.length > 0) {
    throw new ValidationError(
      `Too many arguments: ${extra.join(" ")}. Expected: ${usageHint()}`,
      "positional",
    );
  }
  if (first === undefined) {
    return { target: { type: "auto-detect" } };
  }
  if (second === undefined) {
    if (isIntegrationId(first)) {
      return { target: { type: "auto-detect" }, integration: first };
    }
    if (!first.includes("/")) {
      throw unknownIntegration(
        first,
        "  To name an org or project instead, write it as <org>/<project>, <org>/ or /<project>.\n",
      );
    }
  } else if (isIntegrationId(first)) {
    throw new ValidationError(
      `'${first}' is an integration, and the wizard sets up one at a time.\n` +
        `  To name a project or org called '${first}', write it as <org>/${first}, ${first}/ or /${first}.\n` +
        `  Usage: ${usageHint()}`,
      "integration",
    );
  } else if (!isIntegrationId(second)) {
    throw unknownIntegration(second);
  }
  const { parsed, baseUrl } = parseOrgProjectInput(first);
  return {
    target: parsed,
    ...(baseUrl && { baseUrl }),
    ...(second !== undefined && { integration: second }),
  };
}

/**
 * Whether `SENTRY_SPOTLIGHT` turns on Spotlight mode. Like the Sentry SDKs,
 * any value but an empty or false-like one (`0`, `false`, `off`, …) counts,
 * including a Spotlight URL.
 */
function isSpotlightEnabled(): boolean {
  const value = getEnv()["SENTRY_SPOTLIGHT"]?.trim();
  return value ? parseBoolValue(value) !== false : false;
}

export const wizardCommand = buildCommand({
  auth: false,
  docs: {
    brief: topLevelBrief("wizard"),
    customUsage: [USAGE],
    fullDescription:
      "Set up Sentry in the project in the current directory. The wizard " +
      "asks you a few questions, installs the Sentry SDK for your framework, " +
      "writes its configuration, and sets up source map or debug file " +
      "uploads.\n\n" +
      "It logs in with your `sentry auth login` account (or starts a login) " +
      "on the Sentry instance the rest of the CLI uses, and lets you pick or " +
      "create the Sentry project to send data to. Pass `<org>/<project>` " +
      "first to skip those questions, or `<org>/` to pick only the project. " +
      "Pass an integration, such as `nextjs`, to skip the integration " +
      `picker. Integrations: ${INTEGRATION_IDS.join(", ")}.\n\n` +
      "An integration id is never read as a project or org, and a single " +
      "bare word is always read as an integration. To name a project or " +
      "org, write it with a `/`: `my-org/my-project`, `my-org/`, or " +
      "`/my-project` (for a project spelled like an integration, " +
      "`my-org/nextjs`).\n\n" +
      "Set `SENTRY_SPOTLIGHT=1` to set up Spotlight for local development " +
      "instead, without a Sentry account or login. Use the global " +
      "`--verbose` flag for the wizard's debug output.\n\n" +
      "The wizard changes files in your project. To have a coding agent set " +
      "up Sentry instead, run `sentry init`, which prints the agent's setup " +
      "guide and changes nothing.",
    examples: [
      {
        description: "Pick an integration and a project, then set it up",
        run: "wizard",
      },
      {
        description: "Set up Next.js, picking the project",
        run: "wizard nextjs",
      },
      {
        description: "Set up Next.js for a known org and project",
        run: "wizard my-org/my-project nextjs",
      },
      {
        description: "Set up Next.js for Spotlight, without a Sentry account",
        run: { prefix: "SENTRY_SPOTLIGHT=1 ", args: "wizard nextjs" },
      },
    ],
  },
  parameters: {
    positional: boundArguments({
      placeholder: "org/project-or-integration",
      brief:
        "<org>/<project> to set up (skips the project picker), then the integration (skips the integration picker)",
      kind: ORG_PROJECT_TARGET,
      parse: parseWizardArguments,
      // The org and project resolve after the wizard logs in; only a pasted
      // URL's server applies here, before the login picks an instance.
      resolve: async (input) => {
        if (input.baseUrl) {
          applySentryUrlContext(input.baseUrl);
        }
        return input;
      },
    }),
    flags: {
      force: {
        kind: "boolean",
        brief:
          "Change a project with uncommitted changes without asking, and install the SDK even when the package manager's checks fail",
        default: false,
      },
      "app-target": {
        kind: "parsed",
        parse: parseText,
        optional: true,
        brief:
          "Xcode app target that SnapshotPreviews uses, instead of picking one (appleSnapshots only)",
      },
      "hosted-test-target": {
        kind: "parsed",
        parse: parseText,
        optional: true,
        brief:
          "Hosted XCTest target that renders the snapshots, instead of picking one (appleSnapshots only)",
      },
    },
    aliases: { f: "force" },
  },
  // oxlint-disable-next-line require-yield -- The wizard prints its own interactive output; the command yields none.
  async *func(this: SentryContext, flags: WizardFlags, args: WizardArguments) {
    const { target, integration } = await args.resolved;
    try {
      await runWizard({
        integration,
        wizardOptions: {
          telemetryEnabled: isTelemetryEnabled(),
          target,
          forceInstall: flags.force,
          ignoreGitChanges: flags.force,
          spotlight: isSpotlightEnabled(),
        },
        appleSnapshotsTargets: {
          appTarget: flags["app-target"],
          hostedTestTarget: flags["hosted-test-target"],
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
