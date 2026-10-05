/**
 * General utility functions
 */

import { userInfo } from "node:os";

const ALL_DIGITS_PATTERN = /^\d+$/;
const SINGLE_QUOTE_PATTERN = /'/g;

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
 * Quote a value for safe use as one POSIX shell argument.
 *
 * @param value - Untrusted value to quote
 * @returns A single-quoted shell argument
 */
export function shellQuote(value: string): string {
  return `'${value.replace(SINGLE_QUOTE_PATTERN, "'\\''")}'`;
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
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
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
