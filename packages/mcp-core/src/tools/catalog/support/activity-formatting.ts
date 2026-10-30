import type { IssueActivity } from "../../../api-client/types";
import { formatActor, readString } from "./api-formatting";

const MCP_CLIENT_NAMES = new Map([
  ["claude", "Claude"],
  ["claude-code", "Claude"],
  ["codex", "Codex"],
  ["copilot", "GitHub Copilot"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
]);

function formatActivitySource(
  source: string | null | undefined,
): string | null {
  const [channel, client] = source?.split(":") ?? [];
  switch (channel) {
    case "api":
      return "via API";
    case "sentry-cli":
      return "via Sentry CLI";
    case "mcp": {
      const name = client ? MCP_CLIENT_NAMES.get(client) : undefined;
      return name ? `${name} via MCP` : "via MCP";
    }
    default:
      return null;
  }
}

export function formatActivityAuthor(
  activity: IssueActivity,
  fallback = "system",
): string {
  const actor =
    readString(activity.sentry_app, "name") ??
    readString(activity.sentry_app, "slug") ??
    (activity.user ? formatActor(activity.user) : fallback);
  // Sentry Apps are attributed by name rather than their API channel.
  const source = activity.sentry_app
    ? null
    : formatActivitySource(activity.source);
  return source ? `${actor} (${source})` : actor;
}
