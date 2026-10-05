/**
 * Markdown parsing helpers shared by the skill generator and its tests.
 */

/** Matches a generated command heading and stops before positional usage. */
const COMMAND_HEADING_RE =
  /^`sentry\s+([^<[`\s]+(?:\s+[^<[`\s]+)*)(?:\s*(?:<|\[)[^`]*)?`$/;

/** Extract the literal command path from a generated command heading. */
export function extractCommandPathFromHeading(
  heading: string
): string | undefined {
  const match = COMMAND_HEADING_RE.exec(heading);
  return match?.[1] ? `sentry ${match[1]}` : undefined;
}

/** Find the command whose literal path appears in a loose example block. */
export function matchExampleToCommand(
  code: string,
  commandPaths: readonly string[],
  groupFallback: string,
  defaultCommandPath?: string
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
