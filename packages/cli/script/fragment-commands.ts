/**
 * Find `sentry` command invocations in doc fragment code blocks.
 *
 * Command examples belong in the command's `docs.examples` metadata so they
 * show up in `--help`, the generated docs, and the skill references. A shell
 * code block in a fragment that runs `sentry …` is almost always an example
 * in disguise, whatever its heading says.
 *
 * Multi-step workflows belong there too, as an example whose `command` is an
 * array of steps. Blocks that legitimately need commands (sample output, guides
 * that interleave non-`sentry` commands) opt out with an HTML comment directly
 * above the block:
 *
 *   <!-- allow-commands: sample output with the ACCOUNT column -->
 *   ```bash
 *   sentry org list
 *   ```
 *
 * The reason is required so reviewers can judge each exception.
 */

import { marked, type Token } from "marked";

/** Code block languages treated as shell. An empty string is an unlabeled block. */
const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "console", "zsh"]);

/**
 * A `sentry` invocation: at the start of the line or after a shell operator,
 * optionally behind a `$ ` prompt and `VAR=value` assignments. `sentry-cli`
 * and `sentry.io` don't match.
 */
const SENTRY_COMMAND_RE =
  /(?:^|[|;&(]\s*|\$\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*sentry(?=\s|$)/;

/**
 * Opt-out marker on its own line. Group 1 is the colon and group 2 the reason;
 * both are checked so a bare `<!-- allow-commands -->` is reported, not ignored.
 */
const ALLOW_MARKER_SOURCE =
  "^[ \\t]*<!--\\s*allow-commands\\b\\s*(:?)(.*?)-->[ \\t]*$";
const ALLOW_MARKER_RE = new RegExp(ALLOW_MARKER_SOURCE);
const ALLOW_MARKER_LINES_RE = new RegExp(`${ALLOW_MARKER_SOURCE}\\n?`, "gm");

const MISPLACED_MARKER =
  "allow-commands marker must sit directly above a code block; remove or move it";

/** Remove opt-out markers so they don't leak into generated docs and skills. */
export function stripAllowCommandMarkers(md: string): string {
  return md.replace(ALLOW_MARKER_LINES_RE, "");
}

/** One problem found in a fragment. */
export type FragmentCommandIssue = {
  /** 1-based line of the offending block (or its enclosing block when nested). */
  line: number;
  message: string;
};

/** `sentry` command lines of a shell code block, skipping comment lines. */
function sentryCommandLines(code: string, lang: string): string[] {
  if (!SHELL_LANGS.has(lang)) {
    return [];
  }
  return code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#") && SENTRY_COMMAND_RE.test(line));
}

type Marker = { reason: string } | { invalid: true };

function parseMarker(token: Token | undefined): Marker | undefined {
  if (token?.type !== "html") {
    return;
  }
  const match = ALLOW_MARKER_RE.exec(token.raw.trim());
  if (!match) {
    return;
  }
  const reason = match[2]?.trim();
  return match[1] && reason ? { reason } : { invalid: true };
}

/** Child token lists of a token: inline/block children and list items. */
function childTokenLists(token: Token): Token[][] {
  const lists: Token[][] = [];
  if ("tokens" in token && Array.isArray(token.tokens)) {
    lists.push(token.tokens as Token[]);
  }
  if (token.type === "list") {
    lists.push(token.items as Token[]);
  }
  return lists;
}

function checkTokens(
  tokens: Token[],
  line: (token: Token) => number,
  issues: FragmentCommandIssue[],
): void {
  let previous: Token | undefined;
  for (const token of tokens) {
    if (token.type === "space") {
      continue;
    }
    const marker = parseMarker(previous);
    if (token.type === "code") {
      const lang = (token.lang ?? "").split(" ")[0] ?? "";
      const commands = sentryCommandLines(token.text, lang);
      if (marker && "invalid" in marker) {
        issues.push({
          line: line(token),
          message:
            "allow-commands marker needs a reason: <!-- allow-commands: <why this block needs commands> -->",
        });
      } else if (marker && commands.length === 0) {
        issues.push({
          line: line(token),
          message:
            "allow-commands marker on a block without sentry commands; remove the marker",
        });
      } else if (!marker && commands.length > 0) {
        issues.push({
          line: line(token),
          message: `code block runs \`${commands[0]}\`; move it to the command's docs.examples (multi-step workflows take an array of steps), or mark a sample-output block with <!-- allow-commands: <reason> --> on the line above`,
        });
      }
    } else if (marker) {
      issues.push({
        line: line(previous as Token),
        message: MISPLACED_MARKER,
      });
    }
    for (const children of childTokenLists(token)) {
      checkTokens(children, () => line(token), issues);
    }
    previous = token;
  }
  const trailing = parseMarker(previous);
  if (trailing && previous) {
    issues.push({
      line: line(previous),
      message: MISPLACED_MARKER,
    });
  }
}

/**
 * Report unmarked code blocks that run `sentry` commands, plus markers that
 * are missing a reason or don't cover a command block.
 */
export function findFragmentCommandIssues(md: string): FragmentCommandIssue[] {
  const tokens = marked.lexer(md);
  const lines = new Map<Token, number>();
  let current = 1;
  for (const token of tokens) {
    lines.set(token, current);
    current += token.raw.split("\n").length - 1;
  }
  const issues: FragmentCommandIssue[] = [];
  checkTokens(tokens, (token) => lines.get(token) ?? 1, issues);
  return issues;
}
