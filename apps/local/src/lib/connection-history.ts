import { parseStreamEndpoint } from "./spotlight.ts";

export const CONNECTION_HISTORY_KEY = "sentry.local.recent-connections";
const MAX_CONNECTIONS = 5;

/** Re-pair daemon receivers through discovery, without retaining session capabilities. */
export function receiverAddress(stream: string): string {
  const endpoint = parseStreamEndpoint(stream);
  return endpoint?.kind === "loopback"
    ? new URL("/stream", endpoint.url).toString()
    : stream;
}

/** Display endpoints without query credentials. */
export function connectionLabel(stream: string): string {
  const url = new URL(stream);
  return `${url.origin}${url.pathname}`;
}

export function rememberConnection(
  history: string[],
  stream: string,
): string[] {
  if (!parseStreamEndpoint(stream)) return history;
  const url = receiverAddress(stream);
  const label = connectionLabel(url);
  return [
    url,
    ...history.filter((entry) => connectionLabel(entry) !== label),
  ].slice(0, MAX_CONNECTIONS);
}

/** Query-bearing remote connections stay in this tab's session storage only. */
export function readConnectionHistory(): string[] {
  try {
    const value: unknown = JSON.parse(
      window.sessionStorage.getItem(CONNECTION_HISTORY_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value
      .slice(0, MAX_CONNECTIONS)
      .reduceRight<string[]>(
        (history, entry: unknown) =>
          typeof entry === "string"
            ? rememberConnection(history, entry)
            : history,
        [],
      );
  } catch {
    return [];
  }
}

export function saveConnectionHistory(history: string[]): void {
  try {
    window.sessionStorage.setItem(
      CONNECTION_HISTORY_KEY,
      JSON.stringify(history.slice(0, MAX_CONNECTIONS)),
    );
  } catch {
    // The current tab's in-memory history still works when storage is unavailable.
  }
}

const DISCONNECTED_KEY = "sentry.local.disconnected";
/** An explicit link or user Connect overrides a tab's disconnected landing. */
export function getInitialDisconnected(): boolean {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  if (parseStreamEndpoint(fragment.get("stream") ?? query.get("url") ?? ""))
    return false;
  try {
    return window.sessionStorage.getItem(DISCONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}
export function saveDisconnected(disconnected: boolean): void {
  try {
    if (disconnected) window.sessionStorage.setItem(DISCONNECTED_KEY, "1");
    else window.sessionStorage.removeItem(DISCONNECTED_KEY);
  } catch {
    /* The current tab still works when storage is disabled. */
  }
}
