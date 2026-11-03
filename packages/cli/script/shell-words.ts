/**
 * Split shell lines from doc examples into commands and words.
 *
 * Parsing is done by `shell-quote`, so quoting, escapes, control operators
 * (`&&`, `||`, `|`, `;`), and comments follow shell rules: an operator inside
 * quotes doesn't split a command. Nothing is expanded; `$VAR` and `$(…)` stay
 * literal.
 *
 * Docs write placeholders as `<org>/<project>`, which a shell would read as
 * redirections. They are protected before parsing and restored in the words.
 */

import { parse } from "shell-quote";

/** A `<name>` doc placeholder. */
const ANGLE_PLACEHOLDER_RE = /<[^<>\s]*>/g;
/** A protected placeholder: NUL, its index, NUL. */
const MASKED_PLACEHOLDER_RE = /\0(\d+)\0/g;

/** Operators that end one command and start the next. */
const COMMAND_SEPARATORS = new Set([
  "&&",
  "||",
  "|",
  "|&",
  ";",
  ";;",
  "&",
  "(",
  ")",
]);

/**
 * The commands of one shell line, each as its list of words. Redirections
 * (`> out.json`) are dropped with their targets.
 */
export function shellCommands(line: string): string[][] {
  const placeholders: string[] = [];
  const masked = line.replace(
    ANGLE_PLACEHOLDER_RE,
    (placeholder) => `\0${placeholders.push(placeholder) - 1}\0`,
  );
  const restore = (word: string) =>
    word.replace(
      MASKED_PLACEHOLDER_RE,
      (_, index: string) => placeholders[Number(index)] ?? "",
    );

  const commands: string[][] = [[]];
  let redirectTarget = false;
  for (const entry of parse(masked, (name) => `$${name}`)) {
    const current = commands.at(-1) ?? [];
    if (typeof entry === "string") {
      if (!redirectTarget) {
        current.push(restore(entry));
      }
      redirectTarget = false;
    } else if ("comment" in entry) {
      break;
    } else if (entry.op === "glob") {
      current.push(restore(entry.pattern));
    } else if (COMMAND_SEPARATORS.has(entry.op)) {
      commands.push([]);
    } else {
      redirectTarget = true; // `>`, `>>`, `<`, `2>&1`, …
    }
  }
  return commands.filter((words) => words.length > 0);
}
