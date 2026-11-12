/**
 * Server `instructions` returned from `initialize` (and `server/discover`).
 *
 * Harnesses with tool search, such as Claude Code, load only tool names and
 * these instructions at session start, so this text decides when the model
 * reaches for Sentry tools at all. Every line is steering: it says when to
 * use Sentry or how to route between tools. Leave out product description and
 * anything a tool description already covers once loaded. Claude Code cuts
 * server instructions at 4,096 characters. See docs/mcp/harnesses.md.
 */

export const MAX_SERVER_INSTRUCTIONS_LENGTH = 1_500;

const OVERVIEW =
  "Use Sentry tools for questions about the user's production apps or Sentry account: errors, crashes, issues, stack traces, traces, spans, slow requests, logs, metrics, replays, profiles, releases, monitors, alert rules, and Sentry SDK setup and docs.";

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
      "For a Sentry URL or an issue, event, trace, or replay ID, call get_sentry_resource first.",
    );
  }
  if (toolNames.has("find_organizations")) {
    rules.push(
      "Do not look up the organization first; tools default to it when the user has one. If a tool asks for organizationSlug, call find_organizations and pass the slug and regionUrl it returns.",
    );
  }
  const eventSearchTools = EVENT_SEARCH_TOOL_NAMES.filter((name) =>
    toolNames.has(name),
  );
  if (toolNames.has("search_issues")) {
    rules.push(
      eventSearchTools.length > 0
        ? `search_issues finds grouped problems ("what's broken", "top issues"); ${eventSearchTools.join(", ")} find individual events, counts, and aggregates.`
        : `search_issues finds grouped problems ("what's broken", "top issues").`,
    );
  } else if (eventSearchTools.length > 0) {
    rules.push(
      `${eventSearchTools.join(", ")} find individual events, counts, and aggregates.`,
    );
  }
  if (
    toolNames.has("search_sentry_tools") &&
    toolNames.has("execute_sentry_tool")
  ) {
    rules.push(
      "For a Sentry task no listed tool covers, find the tool with search_sentry_tools and run it with execute_sentry_tool.",
    );
  }

  return [OVERVIEW, ...rules.map((rule) => `- ${rule}`)].join("\n");
}
