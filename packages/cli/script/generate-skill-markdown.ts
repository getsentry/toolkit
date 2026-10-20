/**
 * Markdown parsing helpers shared by the skill generator and its tests.
 */
import type { PositionalInfo } from "../src/lib/introspect.js";

/** Matches a generated command heading and stops before positional usage. */
const COMMAND_HEADING_RE =
  /^`sentry\s+([^<[`\s]+(?:\s+[^<[`\s]+)*)(?:\s*(?:<|\[)[^`]*)?`$/;

/** Extract the literal command path from a generated command heading. */
export function extractCommandPathFromHeading(
  heading: string,
): string | undefined {
  const match = COMMAND_HEADING_RE.exec(heading);
  return match?.[1] ? `sentry ${match[1]}` : undefined;
}

/** Find the command whose literal path appears in a loose example block. */
export function matchExampleToCommand(
  code: string,
  commandPaths: readonly string[],
  groupFallback: string,
  defaultCommandPath?: string,
): string | undefined {
  // Prefer the longest path so `sentry auth login` wins over bare `sentry auth`
  // when both would otherwise match via includes().
  const byLengthDesc = [...commandPaths].sort((a, b) => b.length - a.length);
  const matched = byLengthDesc.find((path) => code.includes(path));
  if (matched) {
    return matched;
  }
  if (!code.includes(groupFallback)) {
    return;
  }
  // Bare group examples (`sentry auth`) belong on the default subcommand when
  // one exists (login), not on a synthetic group-only path.
  return defaultCommandPath ?? groupFallback;
}

/** Render structured command examples in the same form for docs and skills. */
export function formatCommandExamples(examples: readonly string[]): string {
  if (examples.length === 0) {
    return "";
  }
  return ["**Examples:**", "", "```bash", examples.join("\n\n"), "```"].join(
    "\n",
  );
}

/** Format canonical positional syntax as a Markdown argument table. */
export function formatCommandArguments(
  positionals: readonly PositionalInfo[],
): string {
  if (positionals.length === 0) {
    return "";
  }
  const lines = [
    "**Arguments:**",
    "",
    "| Argument | Description |",
    "|----------|-------------|",
  ];
  for (const positional of positionals) {
    const value = `<${positional.placeholder}${positional.variadic ? "..." : ""}>`;
    const syntax =
      positional.syntax ?? (positional.optional ? `[${value}]` : value);
    const brief = positional.brief.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    lines.push(`| \`${syntax}\` | ${brief} |`);
  }
  return lines.join("\n");
}
