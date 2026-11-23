/**
 * Checks a generated MCP Apps view before it is written or accepted as up to
 * date: it fits its byte budget and loads nothing from the network, so it
 * runs under the spec's default CSP with an empty `csp`. See
 * design/mcp-apps.md.
 */

/** Network loads that an empty `csp` would block, so a view must not use them. */
const NETWORK_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["an external src or href", /\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i],
  ["a <link> element", /<link\b/i],
  ["a CSS @import", /@import\b/i],
  ["a CSS url() to another origin", /url\(\s*["']?(?:https?:)?\/\//i],
  ["fetch()", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["navigator.sendBeacon", /\bsendBeacon\b/],
  ["a dynamic import()", /\bimport\s*\(/],
];

/** Returns one message per rule that `html` breaks; empty when it passes. */
export function viewHtmlProblems(
  name: string,
  html: string,
  budgetBytes: number,
): string[] {
  const problems: string[] = [];
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > budgetBytes) {
    problems.push(
      `${name} is ${bytes} bytes, over its ${budgetBytes}-byte budget. Drop a dependency or raise the budget on purpose.`,
    );
  }
  for (const [label, pattern] of NETWORK_PATTERNS) {
    if (pattern.test(html)) {
      problems.push(
        `${name} uses ${label}. A view loads nothing from the network.`,
      );
    }
  }
  return problems;
}
