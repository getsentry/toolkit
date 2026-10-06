/**
 * sentry issue view
 *
 * View detailed information about one or more Sentry issues.
 */

import type { SentryContext } from "../../context.js";
import { getLatestEvent, listReplayIdsForIssue } from "../../lib/api-client.js";
import { spansFlag } from "../../lib/arg-parsing.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError } from "../../lib/errors.js";
import { plainSafeMuted } from "../../lib/formatters/human.js";
import {
  formatIssueView,
  jsonTransformIssueView,
  type SingleIssueViewData,
} from "../../lib/formatters/issue.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import {
  collectReplayIds,
  getReplayIdFromEvent,
} from "../../lib/replay-search.js";
import { getSpanTreeLines } from "../../lib/span-tree.js";
import type { SentryEvent } from "../../types/index.js";
import { IssueViewOutputSchema } from "../../types/index.js";
import {
  collectIssueArgs,
  issueIdsPositional,
  mapIssueArgsConcurrently,
  resolveIssue,
} from "./utils.js";

const log = logger.withTag("issue.view");

/** Usage hint for ContextError messages */
const USAGE_HINT = "sentry issue view <issue> [<issue>...]";

/** Maximum browser tabs opened without an explicit safety override. */
export const MAX_WEB_ISSUES = 5;

type ViewFlags = {
  readonly json: boolean;
  readonly web: boolean;
  readonly force: boolean;
  readonly spans: number;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/**
 * Try to fetch the latest event for an issue.
 * Returns undefined if the fetch fails (non-blocking).
 *
 * @param orgSlug - Organization slug for API routing
 * @param issueId - Issue ID (numeric)
 */
async function tryGetLatestEvent(
  orgSlug: string,
  issueId: string
): Promise<SentryEvent | undefined> {
  try {
    return await getLatestEvent(orgSlug, issueId);
  } catch (error) {
    log.debug("Failed to fetch latest event for issue", error);
    return;
  }
}

/**
 * Try to fetch replay IDs related to an issue.
 * Returns an empty array if the fetch fails (non-blocking).
 */
async function tryListReplayIdsForIssue(
  orgSlug: string,
  issueId: string
): Promise<string[]> {
  try {
    return await listReplayIdsForIssue(orgSlug, issueId);
  } catch (error) {
    log.debug("Failed to fetch replay IDs for issue", error);
    return [];
  }
}

async function buildIssueSpanData(
  orgSlug: string | undefined,
  event: SentryEvent | undefined,
  spans: number
): Promise<Pick<SingleIssueViewData, "spanTreeLines" | "trace">> {
  const spanTreeResult =
    orgSlug && event && spans > 0
      ? await getSpanTreeLines(orgSlug, event, spans)
      : undefined;

  if (spanTreeResult) {
    const trace =
      spanTreeResult.success && spanTreeResult.traceId
        ? { traceId: spanTreeResult.traceId, spans: spanTreeResult.spans ?? [] }
        : null;
    return { trace, spanTreeLines: spanTreeResult.lines };
  }
  if (!orgSlug) {
    return {
      trace: null,
      spanTreeLines: [
        plainSafeMuted("\nOrganization context required to fetch span tree."),
      ],
    };
  }
  if (!event) {
    return {
      trace: null,
      spanTreeLines: [
        plainSafeMuted("\nCould not fetch event to display span tree."),
      ],
    };
  }
  return { trace: null };
}

/**
 * Resolve one issue and attach latest event, replays, and optional span tree.
 */
async function buildSingleIssueViewData(
  issueArg: string,
  cwd: string,
  spans: number
): Promise<SingleIssueViewData> {
  const { org: orgSlug, issue } = await resolveIssue({
    issueArg,
    cwd,
    command: "view",
  });

  const [event, relatedReplayIds] = orgSlug
    ? await Promise.all([
        tryGetLatestEvent(orgSlug, issue.id),
        tryListReplayIdsForIssue(orgSlug, issue.id),
      ])
    : [undefined, []];
  const replayIds = collectReplayIds([
    event ? getReplayIdFromEvent(event) : undefined,
    ...relatedReplayIds,
  ]);
  const spanData = await buildIssueSpanData(orgSlug, event, spans);

  return {
    org: orgSlug ?? null,
    issue,
    event: event ?? null,
    replayIds,
    ...spanData,
  };
}

/** Options for fetching multiple issues in parallel */
type FetchMultipleIssueViewsOptions = {
  /** Issue identifiers as provided on the command line */
  issueArgs: readonly string[];
  /** Working directory for DSN / project detection */
  cwd: string;
  /** Span tree depth (`0` skips the fetch) */
  spans: number;
};

/**
 * Fetch multiple issues with bounded concurrency, collecting successes
 * and warning on failures.
 *
 * Uses the shared issue-batch concurrency limit to avoid overwhelming the API
 * when agents paste dozens of IDs.
 *
 * When all fetches fail, re-throws the error from the primary (first) issue.
 */
export function fetchMultipleIssueViews(
  options: FetchMultipleIssueViewsOptions
): Promise<SingleIssueViewData[]> {
  const { issueArgs, cwd, spans } = options;
  return mapIssueArgsConcurrently(
    issueArgs,
    (issueArg) => buildSingleIssueViewData(issueArg, cwd, spans),
    (issueArg, reason) => {
      log.warn(`Failed to fetch issue ${issueArg}: ${reason}`);
    }
  );
}

/**
 * Resolve and open issue browser pages, respecting the tab safety limit.
 *
 * @param issueArgs - Normalized issue identifiers
 * @param cwd - Working directory for issue resolution
 * @param force - Whether to bypass {@link MAX_WEB_ISSUES}
 */
async function openIssuesInBrowser(
  issueArgs: readonly string[],
  cwd: string,
  force: boolean
): Promise<void> {
  const argsToOpen = force ? issueArgs : issueArgs.slice(0, MAX_WEB_ISSUES);
  if (argsToOpen.length < issueArgs.length) {
    log.warn(
      `Opening the first ${MAX_WEB_ISSUES} of ${issueArgs.length} issues. Use --force to open all.`
    );
  }

  const issues = await mapIssueArgsConcurrently(
    argsToOpen,
    async (issueArg) => {
      const { issue } = await resolveIssue({
        issueArg,
        cwd,
        command: "view",
      });
      return issue;
    },
    (issueArg, reason) => {
      log.warn(`Failed to open issue ${issueArg}: ${reason}`);
    }
  );

  for (const issue of issues) {
    await openInBrowser(issue.permalink, "issue");
  }
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View details of one or more issues",
    fullDescription:
      "View detailed information about Sentry issues by ID or short ID. " +
      "The latest event is automatically included for full context.\n\n" +
      "Issue formats:\n" +
      "  @latest         - Most recent unresolved issue\n" +
      "  @most_frequent  - Issue with highest event frequency\n" +
      "  <org>/ID        - Explicit org: sentry/EXTENSION-7, sentry/cli-G\n" +
      "  <org>/@selector - Selector with org: my-org/@latest\n" +
      "  <project>-suffix - Project + suffix: cli-G, spotlight-electron-4Y\n" +
      "  ID              - Short ID: CLI-G (searches across orgs)\n" +
      "  suffix          - Suffix only: G (requires DSN context)\n" +
      "  numeric         - Numeric ID: 123456789\n" +
      "  org/project#ID  - GitHub-style: my-org/my-project#PROJ-123\n\n" +
      "Multiple issue IDs can be passed as separate arguments or newline-separated\n" +
      "within a single argument (handy when piping from other commands).\n" +
      `With --web, up to ${MAX_WEB_ISSUES} issues open by default; pass --force to open all.\n\n` +
      "In multi-project mode (after 'issue list'), use alias-suffix format (e.g., 'f-g' " +
      "where 'f' is the project alias shown in the list).",
  },
  output: {
    human: formatIssueView,
    jsonTransform: jsonTransformIssueView,
    schema: IssueViewOutputSchema,
  },
  parameters: {
    positional: issueIdsPositional,
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      force: {
        kind: "boolean",
        brief: `Allow --web to open more than ${MAX_WEB_ISSUES} issues`,
        default: false,
      },
      ...spansFlag,
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, w: "web" },
  },
  async *func(this: SentryContext, flags: ViewFlags, ...args: string[]) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const issueArgs = collectIssueArgs(args);
    const [primaryArg] = issueArgs;
    if (primaryArg === undefined) {
      throw new ContextError("Issue ID", USAGE_HINT, []);
    }

    if (flags.web) {
      await openIssuesInBrowser(issueArgs, cwd, flags.force);
      return;
    }

    const views = await fetchMultipleIssueViews({
      issueArgs,
      cwd,
      spans: flags.spans,
    });

    yield new CommandOutput({
      issues: views,
      requestedCount: issueArgs.length,
    });
    return {
      hint: `Tip: Use 'sentry issue explain ${primaryArg}' for AI root cause analysis`,
    };
  },
});
