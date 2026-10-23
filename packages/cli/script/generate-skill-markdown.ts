/**
 * Markdown rendering helpers shared by the docs and skill generators.
 */
import type { PositionalInfo } from "../src/lib/introspect.js";

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
