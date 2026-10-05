/**
 * Issue ID parsing and manipulation utilities
 *
 * Handles parsing of various issue ID formats:
 * - Numeric IDs: "123456"
 * - Full short IDs: "PROJECT-ABC", "SPOTLIGHT-ELECTRON-4Y"
 * - Short suffixes: "ABC", "4Y" (requires project context)
 * - Alias-suffix format: "e-4y", "w-2c" (requires alias cache)
 * - Org-prefixed format: "org/PROJECT-ABC", "org/project-suffix"
 * - GitHub-style format: "org/project#PROJECT-ABC", "project#ABC" (the "#"
 *   replaces the final slash; handled in arg-parsing.ts)
 *
 * Note: parseIssueArg is in arg-parsing.ts for shared logic with org/project parsing.
 */

/** Pattern to detect short IDs (contain letters, vs numeric IDs which are just digits) */
const SHORT_ID_PATTERN = /[a-zA-Z]/;

/** Pattern for short suffix validation (alphanumeric only, no hyphens) */
const SHORT_SUFFIX_PATTERN = /^[a-zA-Z0-9]+$/;

/** Pattern for alias-suffix format (e.g., "f-g", "fr-a3", "spotlight-e-4y") */
const ALIAS_SUFFIX_PATTERN = /^(.+)-([a-zA-Z0-9]+)$/i;

/**
 * Check if a string looks like a short ID (e.g., PROJECT-ABC)
 * vs a numeric ID (e.g., 123456).
 *
 * Short IDs contain at least one letter. Numeric IDs are pure digits.
 */
export function isShortId(issueId: string): boolean {
  return SHORT_ID_PATTERN.test(issueId);
}

/**
 * Check if input looks like a short suffix (just the unique part without project prefix).
 * A short suffix has no hyphen and contains only alphanumeric characters.
 *
 * Examples: "G", "A3", "b2", "ABC", "12"
 */
export function isShortSuffix(input: string): boolean {
  return !input.includes("-") && SHORT_SUFFIX_PATTERN.test(input);
}

/**
 * Try to parse input as alias-suffix format (e.g., "f-g", "fr-a3").
 * Returns the parsed alias and suffix, or null if not matching the pattern.
 *
 * Note: This only checks the format, not whether the alias exists.
 * The caller should verify the alias exists in the cache.
 *
 * @param input - The input string to parse
 * @returns Parsed alias (lowercase) and suffix (uppercase), or null
 */
export function parseAliasSuffix(
  input: string
): { alias: string; suffix: string } | null {
  const match = ALIAS_SUFFIX_PATTERN.exec(input);
  if (!(match?.[1] && match[2])) {
    return null;
  }
  // Return lowercase alias (aliases are stored lowercase)
  return { alias: match[1].toLowerCase(), suffix: match[2].toUpperCase() };
}

/**
 * Expand a short suffix to a full short ID using the project slug.
 *
 * @param suffix - The short suffix (e.g., "G", "4Y")
 * @param projectSlug - The project slug (e.g., "craft", "spotlight-electron")
 * @returns Full short ID (e.g., "CRAFT-G", "SPOTLIGHT-ELECTRON-4Y")
 */
export function expandToFullShortId(
  suffix: string,
  projectSlug: string
): string {
  return `${projectSlug.toUpperCase()}-${suffix.toUpperCase()}`;
}
