/**
 * Server `instructions` returned from `initialize` (and `server/discover`).
 *
 * Harnesses with tool search, such as Claude Code, load only tool names and
 * these instructions at session start, so this text decides when the model
 * reaches for Sentry tools at all. Keep it short: Claude Code cuts server
 * instructions at 4,096 characters. See docs/mcp/harnesses.md.
 */

export const MAX_SERVER_INSTRUCTIONS_LENGTH = 1_500;

const OVERVIEW =
  "Sentry monitors errors and performance in the user's applications. Use these tools when the user asks about production behavior or their Sentry account: errors, exceptions, and crashes; Sentry issues and stack traces; traces, spans, and slow requests; logs; metrics; session replays; profiles; releases; cron, uptime, and metric monitors; alert rules; or Sentry SDK setup and docs.";

const EVENT_SEARCH_TOOL_NAMES = [
  "search_errors",
  "search_logs",
  "search_traces",
  "search_metrics",
  "search_profiles",
  "search_replays",
] as const;

/**
 * Builds the instructions for the tools this server registered. Rules that
 * name a tool are left out when the granted skills or constraints did not
 * register it, so the text never points at a tool the client cannot call.
 */
export function buildServerInstructions(
  toolNames: ReadonlySet<string>,
): string | undefined {
  if (toolNames.size === 0) {
    return undefined;
  }

  const rules: string[] = [];
  if (toolNames.has("get_sentry_resource")) {
    rules.push(
      "When the user shares a Sentry URL, or an issue, event, trace, or replay ID, call get_sentry_resource first.",
    );
  }
  if (toolNames.has("find_organizations")) {
    rules.push(
      "Tools pick the organization automatically when the user has only one. If a tool asks for organizationSlug, call find_organizations and pass the slug and regionUrl it returns.",
    );
  }
  const eventSearchTools = EVENT_SEARCH_TOOL_NAMES.filter((name) =>
    toolNames.has(name),
  );
  if (toolNames.has("search_issues")) {
    rules.push(
      eventSearchTools.length > 0
        ? `Use search_issues for grouped problems ("what's broken", "top issues") and ${eventSearchTools.join(", ")} for individual events, counts, and aggregates.`
        : `Use search_issues for grouped problems ("what's broken", "top issues").`,
    );
  } else if (eventSearchTools.length > 0) {
    rules.push(
      `Use ${eventSearchTools.join(", ")} for individual events, counts, and aggregates.`,
    );
  }
  if (
    toolNames.has("search_sentry_tools") &&
    toolNames.has("execute_sentry_tool")
  ) {
    rules.push(
      "More Sentry tools exist than are listed: find them with search_sentry_tools and run them with execute_sentry_tool.",
    );
  }

  return [OVERVIEW, ...rules.map((rule) => `- ${rule}`)].join("\n");
}
