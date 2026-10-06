/**
 * Command synonym suggestion registry.
 *
 * Maps unknown command tokens to context-aware suggestions, keyed by
 * `"routeContext/unknownToken"`. Used by the `exceptionWhileParsingArguments`,
 * `exceptionWhileRunningCommand`, and `noCommandRegisteredForInput` overrides
 * in app.ts to help users who type commands that don't exist.
 *
 * Populated from CLI-Q3 telemetry analysis (~100 events, 85 users).
 */

/** A suggestion for an unknown command token. */
export type CommandSuggestion = {
  /** The command to suggest (shown in "Tip:" hint) */
  command: string;
  /** Optional explanation of why this is suggested */
  explanation?: string;
};

/**
 * Synonym map: `routeContext/unknownToken` → suggestion.
 *
 * Route context is the last successfully matched route segment before
 * the unknown token. For top-level routes, prefix with `/`.
 */
const SUGGESTIONS: ReadonlyMap<string, CommandSuggestion> = new Map([
  // --- issue events (most common, ~20 events) ---
  [
    "issue/events",
    {
      command: "sentry issue view <issue-id>",
      explanation: "To see events for an issue, view the issue details",
    },
  ],

  // --- view synonyms (~15 events) ---
  ["issue/get", { command: "sentry issue view <issue-id>" }],
  ["issue/details", { command: "sentry issue view <issue-id>" }],
  ["issue/detail", { command: "sentry issue view <issue-id>" }],
  ["issue/info", { command: "sentry issue view <issue-id>" }],

  // --- mutation commands (~8 events) ---
  [
    "issue/resolve",
    {
      command:
        'sentry api /api/0/organizations/{org}/issues/{issue_id}/ --method PUT --data \'{"status":"resolved"}\'',
      explanation: "Issue mutations are available via the API",
    },
  ],
  [
    "issue/update",
    {
      command:
        "sentry api /api/0/organizations/{org}/issues/{issue_id}/ --method PUT",
      explanation: "Issue mutations are available via the API",
    },
  ],
  [
    "issue/set-status",
    {
      command:
        'sentry api /api/0/organizations/{org}/issues/{issue_id}/ --method PUT --data \'{"status":"..."}\'',
      explanation: "Issue status changes are available via the API",
    },
  ],
  [
    "issue/close",
    {
      command:
        'sentry api /api/0/organizations/{org}/issues/{issue_id}/ --method PUT --data \'{"status":"resolved"}\'',
      explanation: "Issue status changes are available via the API",
    },
  ],
  [
    "issue/ignore",
    {
      command:
        'sentry api /api/0/organizations/{org}/issues/{issue_id}/ --method PUT --data \'{"status":"ignored"}\'',
      explanation: "Issue status changes are available via the API",
    },
  ],
  [
    "issue/assign",
    {
      command:
        'sentry api /api/0/organizations/{org}/issues/{issue_id}/ --method PUT --data \'{"assignedTo":"..."}\'',
      explanation: "Issue assignment is available via the API",
    },
  ],
  [
    "issue/comment",
    {
      command:
        'sentry api /api/0/organizations/{org}/issues/{issue_id}/comments/ --method POST --data \'{"text":"..."}\'',
      explanation: "Issue commenting is available via the API",
    },
  ],

  // --- old sentry-cli commands (~5 events) ---
  ["cli/info", { command: "sentry auth status" }],
  ["cli/send-event", { command: "sentry event send" }],
  ["cli/issues", { command: "sentry issue list" }],
  ["cli/logs", { command: "sentry log list" }],

  // --- dashboard synonyms ---
  ["dashboard/default-overview", { command: "sentry dashboard list" }],

  // --- issue trends (from telemetry) ---
  [
    "issue/trends",
    {
      command: "sentry issue list --sort freq",
      explanation: "Use issue list with sort options for trend analysis",
    },
  ],

  // --- issue latest-event (from telemetry) ---
  ["issue/latest-event", { command: "sentry issue view <issue-id>" }],

  // --- issue search/find ---
  ["issue/search", { command: "sentry issue list --query <search>" }],
  ["issue/find", { command: "sentry issue list --query <search>" }],
]);

/**
 * Look up a suggestion for an unknown command token.
 *
 * @param routeContext - The parent route (e.g., "issue", "dashboard"), or empty string for top-level
 * @param unknownToken - The unrecognized token (case-insensitive)
 * @returns A suggestion, or undefined if no match
 */
export function getCommandSuggestion(
  routeContext: string,
  unknownToken: string
): CommandSuggestion | undefined {
  const key = routeContext
    ? `${routeContext}/${unknownToken.toLowerCase()}`
    : `/${unknownToken.toLowerCase()}`;
  return SUGGESTIONS.get(key);
}

/**
 * Check process.argv for a known synonym and return the suggestion string.
 *
 * Inspects argv for the pattern `[routeGroup, unknownToken, ...]` where
 * `unknownToken` is in the synonym map. Returns the formatted suggestion
 * string or undefined if no match.
 *
 * Used by `exceptionWhileParsingArguments` (Cases A/B) and
 * `exceptionWhileRunningCommand` (Case C) in app.ts.
 */
export function getSynonymSuggestionFromArgv(): string | undefined {
  const args = process.argv.slice(2);
  const nonFlags = args.filter((t) => !t.startsWith("-"));
  if (nonFlags.length < 2) {
    return;
  }

  const routeContext = nonFlags[0];
  const unknownToken = nonFlags[1];
  if (!(routeContext && unknownToken)) {
    return;
  }

  const suggestion = getCommandSuggestion(routeContext, unknownToken);
  if (!suggestion) {
    return;
  }

  return suggestion.explanation
    ? `${suggestion.explanation}: ${suggestion.command}`
    : suggestion.command;
}
