/**
 * Minimal shell word splitting for doc examples: whitespace separates words,
 * single and double quotes group them, and a leading `#` starts a comment.
 * No expansion is performed; `$(…)` and variables stay literal.
 */

/** Split a shell command into words, honoring single and double quotes. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let hasToken = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "#" && !hasToken) {
      break; // comment
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}
