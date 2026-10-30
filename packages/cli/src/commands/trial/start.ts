/**
 * sentry trial start
 *
 * Start a product trial for an organization.
 * Supports swap detection: `sentry trial start my-org seer` works
 * the same as `sentry trial start seer my-org`.
 *
 * The special name "plan" triggers the plan-level trial flow, which
 * opens the billing page in a browser (since there's no API for it).
 */

import { isatty } from "node:tty";

import type { SentryContext } from "../../context.js";
import {
  getCustomerTrialInfo,
  getProductTrials,
  startProductTrial,
} from "../../lib/api-client.js";
import { detectSwappedTrialArgs } from "../../lib/arg-parsing.js";
import { openBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { ORG_TARGET } from "../../lib/completion-target.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import { success } from "../../lib/formatters/colors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger as log } from "../../lib/logger.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../lib/positional-parse.js";
import { generateQRCode } from "../../lib/qrcode.js";
import { buildBillingUrl } from "../../lib/sentry-web-urls.js";
import {
  type OrgInput,
  parseOrgInput,
  resolveOrgInput,
} from "../../lib/target-positional.js";
import {
  findAvailableTrial,
  getDisplayNameForTrialName,
  getTrialDisplayName,
  getValidTrialNames,
  isTrialName,
} from "../../lib/trials.js";

const VALID_NAMES = getValidTrialNames();
const NAMES_LIST = `${VALID_NAMES.join(", ")}, plan`;

/**
 * Check if a string is a valid trial name, including the "plan" pseudo-trial.
 *
 * Used for swap detection so `sentry trial start my-org plan` is auto-corrected
 * to `sentry trial start plan my-org`.
 */
function isValidTrialArg(name: string): boolean {
  return name === "plan" || isTrialName(name);
}

const USAGE = "<name> [<org>]";
const USAGE_HINT = `sentry trial start ${USAGE}`;

/** Parsed `trial start` arguments. */
export type TrialStartInput = {
  /** Trial name, or "plan" for the plan-level trial */
  readonly name: string;
  /** The org to start the trial for */
  readonly org: OrgInput;
  /** Warning for reversed arguments, if any */
  readonly warning?: string;
};

/** A trial name and the org to start it for. */
export type ResolvedTrialStart = {
  readonly name: string;
  readonly org: string;
};

/** The arguments of `trial start`. */
export type TrialStartArguments = BoundArguments<
  TrialStartInput,
  ResolvedTrialStart
>;

/**
 * Parse the positional args for `trial start`, handling swapped order.
 * Has no side effects.
 *
 * Expected: `<name> [org]`
 * Also accepted: `<org> <name>` (detected and auto-corrected)
 *
 * @throws {ContextError} When no trial name is given
 * @throws {ValidationError} When there are more than two arguments, the
 *   trial name is unknown, or the org is malformed
 */
export function parseTrialStartArguments(
  args: readonly string[],
): TrialStartInput {
  const [first, second, ...extra] = args;
  if (first === undefined) {
    throw new ContextError("Trial name", USAGE_HINT, [
      `Valid trial names: ${NAMES_LIST}`,
    ]);
  }
  if (extra.length > 0) {
    throw new ValidationError(
      `Too many arguments: ${extra.join(" ")}. Expected: ${USAGE_HINT}`,
      "positional",
    );
  }

  // Two args — check for swapped order (includes "plan" pseudo-trial)
  const swapped =
    second === undefined
      ? null
      : detectSwappedTrialArgs(first, second, isValidTrialArg);
  const name = swapped ? swapped.name : first;
  const org = swapped ? swapped.org : second;

  // Validate trial name — "plan" is a special pseudo-name
  if (!isValidTrialArg(name)) {
    throw new ValidationError(
      `Unknown trial name: '${name}'. Valid names: ${NAMES_LIST}`,
      "name",
    );
  }

  return {
    name,
    org: parseOrgInput(org, USAGE_HINT),
    ...(swapped && { warning: swapped.warning }),
  };
}

export const startCommand = buildCommand({
  destructive: true,
  docs: {
    brief: "Start a product trial",
    customUsage: [USAGE],
    fullDescription:
      "Start a product trial for an organization.\n\n" +
      `Valid trial names: ${NAMES_LIST}\n\n` +
      "Use 'plan' to start a Business plan trial (opens billing page).",
    examples: [
      { description: "Start a Seer trial", command: "sentry trial start seer" },
      {
        description: "Start a trial for a specific organization",
        command: "sentry trial start replays my-org",
      },
      {
        description: "Start a Business plan trial (opens the browser)",
        command: "sentry trial start plan",
      },
      {
        description: "Output the result as JSON",
        command: "sentry trial start --json seer",
      },
    ],
  },
  output: { human: formatStartResult },
  parameters: {
    positional: boundArguments({
      placeholder: "name",
      brief: `Trial name (${NAMES_LIST}) and organization slug (auto-detected if omitted)`,
      kind: ORG_TARGET,
      parse: parseTrialStartArguments,
      resolve: async (
        input,
        context: SentryContext,
      ): Promise<ResolvedTrialStart> => {
        if (input.warning) {
          log.withTag("trial").warn(input.warning);
        }
        const { org } = await resolveOrgInput(
          input.org,
          context.cwd,
          "sentry trial start <name> <org>",
        );
        return { name: input.name, org };
      },
    }),
  },
  async *func(
    this: SentryContext,
    flags: { json?: boolean },
    target: TrialStartArguments,
  ) {
    const parsed = await target.resolved;
    const orgSlug = parsed.org;

    // Plan trial: no API to start it — open billing page instead
    if (parsed.name === "plan") {
      yield* handlePlanTrial(orgSlug, flags.json ?? false);
      return;
    }

    // Fetch trials and find an available one
    const trials = await getProductTrials(orgSlug);
    const trial = findAvailableTrial(trials, parsed.name);

    if (!trial) {
      const displayName = getDisplayNameForTrialName(parsed.name);
      throw new ValidationError(
        `No ${displayName} trial available for organization '${orgSlug}'.`,
        "name",
      );
    }

    // Start the trial
    await startProductTrial(orgSlug, trial.category);

    yield new CommandOutput({
      name: parsed.name,
      category: trial.category,
      organization: orgSlug,
      lengthDays: trial.lengthDays,
      started: true,
    });
    return;
  },
});

/**
 * Prompt to open a billing URL in the browser if interactive.
 *
 * @returns true if browser was opened, false otherwise
 */
async function promptOpenBrowser(url: string): Promise<boolean> {
  const logger = log.withTag("trial");

  // Prompt to open browser if interactive TTY (stdin for input, stderr for display)
  if (isatty(0) && isatty(2)) {
    const confirmed = await logger.prompt("Open in browser?", {
      type: "confirm",
      initial: true,
    });

    // Symbol(clack:cancel) is truthy — strict equality check
    if (confirmed === true) {
      const opened = await openBrowser(url);
      if (opened) {
        logger.success("Opening in browser...");
      } else {
        logger.warn("Could not open browser. Visit the URL above.");
      }
      return opened;
    }
  }

  return false;
}

/**
 * Handle the "plan" pseudo-trial: check eligibility, show billing URL,
 * prompt to open browser + show QR code.
 *
 * There's no API to start a plan-level trial programmatically — the user
 * must activate it through the Sentry billing UI. This flow makes that as
 * smooth as possible from the terminal.
 *
 * Yields intermediate display data (URL + QR code) so it flows through
 * the output framework, then yields the final result.
 */
async function* handlePlanTrial(
  orgSlug: string,
  json: boolean,
): AsyncGenerator<unknown, void, undefined> {
  const logger = log.withTag("trial");

  // Check if plan trial is actually available
  const info = await getCustomerTrialInfo(orgSlug);

  if (info.isTrial) {
    const planName = info.planDetails?.name ?? "Business";
    throw new ValidationError(
      `Organization '${orgSlug}' is already on a ${planName} plan trial.`,
      "name",
    );
  }

  // Consistent with list.ts: only proceed when canTrial is explicitly true
  if (info.canTrial !== true) {
    throw new ValidationError(
      `No plan trial available for organization '${orgSlug}'.`,
      "name",
    );
  }

  const url = buildBillingUrl(orgSlug);
  let opened = false;

  // In JSON mode, skip interactive output — just return the data
  if (!json) {
    const currentPlan = info.planDetails?.name ?? "current plan";
    logger.info(
      `The ${currentPlan} → Business plan trial must be activated in the Sentry UI.`,
    );

    // Show URL and QR code through the output framework
    const qr = await generateQRCode(url);
    yield new CommandOutput({ url, qr });

    opened = await promptOpenBrowser(url);
  }

  yield new CommandOutput({
    name: "plan",
    category: "plan",
    organization: orgSlug,
    url,
    opened,
  });
}

/** Format start result as human-readable output */
function formatStartResult(data: {
  name?: string;
  category?: string;
  organization?: string;
  lengthDays?: number | null;
  started?: boolean;
  url?: string;
  qr?: string;
  opened?: boolean;
}): string {
  // Intermediate URL + QR code yield for plan trials
  if (data.url && data.qr && !data.category) {
    return `\n  ${data.url}\n\n${data.qr}`;
  }

  // Plan trial final result — URL/QR already displayed
  if (data.category === "plan") {
    return "";
  }

  const displayName = getTrialDisplayName(data.category ?? "");
  const daysText = data.lengthDays ? ` (${data.lengthDays} days)` : "";
  return `${success("✓")} ${displayName} trial started for ${data.organization}!${daysText}`;
}
