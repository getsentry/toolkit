/**
 * General utility functions
 */

import { userInfo } from "node:os";

const ALL_DIGITS_PATTERN = /^\d+$/;
const SINGLE_QUOTE_PATTERN = /['\u2018-\u201b]/g;

/**
 * Check if a string contains only digits (0-9).
 * Useful for distinguishing numeric IDs from slugs/short IDs.
 *
 * @example
 * isAllDigits("123456") // true
 * isAllDigits("PROJECT-ABC") // false
 * isAllDigits("abc123") // false
 * isAllDigits("") // false
 */
export function isAllDigits(str: string): boolean {
  return ALL_DIGITS_PATTERN.test(str);
}

/**
 * Count occurrences of a single character in a string without allocating.
 *
 * @example
 * countChar("org/project/rule", "/") // 2
 */
export function countChar(str: string, char: string): number {
  let count = 0;
  for (let i = str.indexOf(char); i !== -1; i = str.indexOf(char, i + 1)) {
    count += 1;
  }
  return count;
}

/**
 * Parse an absolute HTTP(S) URL without embedded credentials.
 *
 * @param value - Untrusted URL string
 * @returns The parsed URL, or undefined for malformed or relative input,
 *   other schemes, and URLs with a username or password
 */
export function parseHttpUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) {
    return;
  }
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return;
  }
  return url;
}

/**
 * Quote a value for safe use as one POSIX shell argument.
 *
 * Double-quoted apostrophe segments also support inline flag values in
 * PowerShell, which treats typographic apostrophes as single quotes.
 *
 * @param value - Untrusted value to quote
 * @returns A single-quoted shell argument
 */
export function shellQuote(value: string): string {
  return `'${value.replace(SINGLE_QUOTE_PATTERN, (quote) => `'"${quote}"'`)}'`;
}

/**
 * Convert a project name to its expected Sentry slug.
 * Aligned with Sentry's canonical implementation:
 * https://github.com/getsentry/sentry/blob/master/static/app/utils/slugify.tsx
 *
 * Diverges from Sentry's frontend canonical version in one place: `/` and `\`
 * are normalized to a space before invalid-character stripping, so structural
 * separators (npm scopes, monorepo path segments) become hyphens instead of
 * being silently dropped. Without this, `@scope/pkg` would slugify to
 * `scopepkg` instead of `scope-pkg`.
 *
 * @example slugify("My Cool App")    // "my-cool-app"
 * @example slugify("my-app")         // "my-app"
 * @example slugify("Café Project")   // "cafe-project"
 * @example slugify("my_app")         // "my_app"
 * @example slugify("@t3tools/web")   // "t3tools-web"
 * @example slugify("packages/api")   // "packages-api"
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\\/]+/g, " ")
    .replace(/[^a-z0-9_\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Determine the real (non-root) username of the invoking user.
 *
 * When running under `sudo`, `SUDO_USER` holds the original user's login name.
 * Falls back to `USER` / `USERNAME` env vars, then `os.userInfo()`.
 * Used for building `chown` instructions and messages.
 */
export function getRealUsername(): string {
  // userInfo() can throw on systems with missing or corrupted passwd entries.
  let osUsername = "";
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    osUsername = userInfo().username;
  } catch {
    // Fall through to the "$(whoami)" literal below.
  }
  return (
    process.env.SUDO_USER ||
    process.env.USER ||
    process.env.USERNAME ||
    osUsername ||
    "$(whoami)"
  );
}
