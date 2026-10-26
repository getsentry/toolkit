/**
 * Markdown rendering helpers shared by the docs and skill generators.
 */
import type { CommandInfo, PositionalInfo } from "../src/lib/introspect.js";

/** Render structured command examples in the same form for docs and skills. */
export function formatCommandExamples(examples: readonly string[]): string {
  if (examples.length === 0) {
    return "";
  }
  return ["**Examples:**", "", "```bash", examples.join("\n\n"), "```"].join(
    "\n",
  );
}

/**
 * Describe a destructive command's risk, or return "" for other commands.
 *
 * Driven by the `destructive` command metadata, so the docs and skill
 * references flag the same commands as the agent Safety Rules.
 */
export function formatDestructiveNotice(
  cmd: Pick<CommandInfo, "destructive" | "flags">,
): string {
  if (!cmd.destructive) {
    return "";
  }
  const notice =
    "This command deletes data or makes changes that can't easily be undone.";
  const canDryRun = cmd.flags.some((f) => f.name === "dry-run" && !f.hidden);
  return canDryRun
    ? `${notice} Use \`--dry-run\` to preview the changes first.`
    : notice;
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
