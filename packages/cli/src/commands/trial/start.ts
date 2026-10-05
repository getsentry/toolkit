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
import { ContextError, ValidationError } from "../../lib/errors.js";
import { success } from "../../lib/formatters/colors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger as log } from "../../lib/logger.js";
import { generateQRCode } from "../../lib/qrcode.js";
import { resolveOrg } from "../../lib/resolve-target.js";
import { buildBillingUrl } from "../../lib/sentry-urls.js";
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

/**
 * Parse the positional args for `trial start`, handling swapped order.
 *
 * Expected: `<name> [org]`
 * Also accepted: `<org> <name>` (detected and auto-corrected)
 *
 * @returns Parsed name and optional org, plus any warning message
 */
function parseTrialStartArgs(
  first: string,
  second?: string
): { name: string; org?: string; warning?: string } {
  if (!second) {
    // Single arg — must be a trial name
    return { name: first };
  }

  // Two args — check for swapped order (includes "plan" pseudo-trial)
  const swapped = detectSwappedTrialArgs(first, second, isValidTrialArg);
  if (swapped) {
    return { name: swapped.name, org: swapped.org, warning: swapped.warning };
  }

  // Normal order: first=name, second=org
  return { name: first, org: second };
}

export const startCommand = buildCommand({
  docs: {
    brief: "Start a product trial",
    fullDescription:
      "Start a product trial for an organization.\n\n" +
      `Valid trial names: ${NAMES_LIST}\n\n` +
      "Use 'plan' to start a Business plan trial (opens billing page).\n\n" +
      "Examples:\n" +
      "  sentry trial start seer\n" +
      "  sentry trial start seer my-org\n" +
      "  sentry trial start replays\n" +
      "  sentry trial start plan\n" +
      "  sentry trial start --json seer",
  },
  output: { human: formatStartResult },
  parameters: {
    positional: {
      kind: "tuple" as const,
      parameters: [
        {
          placeholder: "name",
          brief: `Trial name (${NAMES_LIST})`,
          parse: String,
        },
        {
          placeholder: "org",
          brief: "Organization slug (auto-detected if omitted)",
          parse: String,
          optional: true as const,
        },
      ],
    },
  },
  async *func(
    this: SentryContext,
    flags: { json?: boolean },
    first: string,
    second?: string
  ) {
    const logger = log.withTag("trial");
    const parsed = parseTrialStartArgs(first, second);

    if (parsed.warning) {
      logger.warn(parsed.warning);
    }

    // Validate trial name — "plan" is a special pseudo-name
    if (parsed.name !== "plan" && !isTrialName(parsed.name)) {
      throw new ValidationError(
        `Unknown trial name: '${parsed.name}'. Valid names: ${NAMES_LIST}`,
        "name"
      );
    }

    // Resolve organization
    const resolved = await resolveOrg({
      org: parsed.org,
      cwd: this.cwd,
    });

    if (!resolved) {
      throw new ContextError("Organization", "sentry trial start <name> <org>");
    }

    const orgSlug = resolved.org;

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
        "name"
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
  json: boolean
): AsyncGenerator<unknown, void, undefined> {
  const logger = log.withTag("trial");

  // Check if plan trial is actually available
  const info = await getCustomerTrialInfo(orgSlug);

  if (info.isTrial) {
    const planName = info.planDetails?.name ?? "Business";
    throw new ValidationError(
      `Organization '${orgSlug}' is already on a ${planName} plan trial.`,
      "name"
    );
  }

  // Consistent with list.ts: only proceed when canTrial is explicitly true
  if (info.canTrial !== true) {
    throw new ValidationError(
      `No plan trial available for organization '${orgSlug}'.`,
      "name"
    );
  }

  const url = buildBillingUrl(orgSlug);
  let opened = false;

  // In JSON mode, skip interactive output — just return the data
  if (!json) {
    const currentPlan = info.planDetails?.name ?? "current plan";
    logger.info(
      `The ${currentPlan} → Business plan trial must be activated in the Sentry UI.`
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
