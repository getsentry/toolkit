/**
 * sentry issue explain
 *
 * Get root cause analysis for a Sentry issue using Seer AI.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { ApiError, ContextError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  formatIssueExplain,
  handleSeerApiError,
  type IssueExplainResult,
  jsonTransformIssueExplain,
} from "../../lib/formatters/seer.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { extractRootCauses } from "../../types/seer.js";
import {
  collectIssueArgs,
  ensureRootCauseAnalysis,
  issueIdsPositional,
  mapIssueArgsConcurrently,
  resolveOrgAndIssueId,
} from "./utils.js";

const log = logger.withTag("issue.explain");
const USAGE_HINT = "sentry issue explain <issue> [<issue>...]";

type ExplainFlags = {
  readonly json: boolean;
  readonly force: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

async function analyzeIssue(
  issueArg: string,
  cwd: string,
  flags: ExplainFlags,
  suppressProgress: boolean
): Promise<IssueExplainResult> {
  let resolvedOrg: string | undefined;

  try {
    const { org, issueId } = await resolveOrgAndIssueId({
      issueArg,
      cwd,
      command: "explain",
    });
    resolvedOrg = org;

    const state = await ensureRootCauseAnalysis({
      org,
      issueId,
      json: suppressProgress,
      force: flags.force,
    });
    const rootCauses = extractRootCauses(state);
    if (rootCauses.length === 0) {
      throw new Error(
        "Analysis completed but no root causes found. " +
          "The issue may not have enough context for root cause analysis."
      );
    }

    return { issue: issueArg, org, issueId, rootCauses };
  } catch (error) {
    if (error instanceof ApiError) {
      throw handleSeerApiError(error.status, error.detail, resolvedOrg);
    }
    throw error;
  }
}

export const explainCommand = buildCommand({
  docs: {
    brief: "Analyze one or more issues using Seer AI",
    fullDescription:
      "Get root cause analyses for one or more Sentry issues using Seer AI.\n\n" +
      "This command analyzes the issue and provides:\n" +
      "  - Identified root causes\n" +
      "  - Reproduction steps\n" +
      "  - Relevant code locations\n\n" +
      "The analysis may take a few minutes for new issues.\n" +
      "Use --force to trigger a fresh analysis even if one already exists.\n\n" +
      "Issue formats:\n" +
      "  @latest          - Most recent unresolved issue\n" +
      "  @most_frequent   - Issue with highest event frequency\n" +
      "  <org>/ID         - Explicit org: sentry/EXTENSION-7, sentry/cli-G\n" +
      "  <org>/@selector  - Selector with org: my-org/@latest\n" +
      "  <project>-suffix - Project + suffix: cli-G, spotlight-electron-4Y\n" +
      "  ID               - Short ID: CLI-G (searches across orgs)\n" +
      "  suffix           - Suffix only: G (requires DSN context)\n" +
      "  numeric          - Numeric ID: 123456789\n\n" +
      "Multiple issue IDs can be passed as separate arguments or newline-separated\n" +
      "within a single argument.\n\n" +
      "Examples:\n" +
      "  sentry issue explain @latest\n" +
      "  sentry issue explain 123456789\n" +
      "  sentry issue explain sentry/EXTENSION-7\n" +
      "  sentry issue explain cli-G\n" +
      "  sentry issue explain CLI-G BACK-2\n" +
      "  sentry issue explain 123456789 --json\n" +
      "  sentry issue explain 123456789 --force",
  },
  output: {
    human: formatIssueExplain,
    jsonTransform: jsonTransformIssueExplain,
  },
  parameters: {
    positional: issueIdsPositional,
    flags: {
      force: {
        kind: "boolean",
        brief: "Force new analysis even if one exists",
        default: false,
      },
      fresh: FRESH_FLAG,
    },
    aliases: FRESH_ALIASES,
  },
  async *func(this: SentryContext, flags: ExplainFlags, ...args: string[]) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const issueArgs = collectIssueArgs(args);
    const [primaryArg] = issueArgs;
    if (primaryArg === undefined) {
      throw new ContextError("Issue ID", USAGE_HINT, []);
    }

    const isBatch = issueArgs.length > 1;
    if (isBatch && !flags.json) {
      log.info(`Analyzing ${issueArgs.length} issues...`);
    }
    const results = await mapIssueArgsConcurrently(
      issueArgs,
      (issueArg) => analyzeIssue(issueArg, cwd, flags, flags.json || isBatch),
      (issueArg, reason) => {
        log.warn(`Failed to analyze issue ${issueArg}: ${reason}`);
      }
    );

    yield new CommandOutput({
      results,
      requestedCount: issueArgs.length,
    });
    return isBatch
      ? undefined
      : { hint: `To create a plan, run: sentry issue plan ${primaryArg}` };
  },
});
