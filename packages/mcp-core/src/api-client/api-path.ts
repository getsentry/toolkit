import { encodeApiPathSegment } from "@sentry/toolkit-core/api-path-segment";
import { UserInputError } from "../errors";

/**
 * Builds an API request path, confining each interpolated value to one path segment.
 *
 * `fetch` resolves dot segments during URL parsing, so a raw value in a path can
 * rewrite it above the org and project the server injected. Encoding stops separators
 * but not `.` or `..`, which survive encoding and still collapse (the URL spec treats
 * `%2e%2e` as a dot segment too), so those are rejected instead.
 *
 * Query strings go outside the template, since `URLSearchParams` has already encoded
 * them and their separators must stay literal:
 *
 * ```typescript
 * const path = apiPath`/organizations/${organizationSlug}/issues/`;
 * await this.requestJSON(`${path}?${query}`);
 * ```
 */
export function apiPath(
  strings: TemplateStringsArray,
  ...values: (string | number)[]
): string {
  return strings.reduce((acc, literal, index) => {
    if (index >= values.length) {
      return acc + literal;
    }

    const value = String(values[index]);
    const encoded = encodeApiPathSegment(value);
    if (encoded === null) {
      throw new UserInputError(
        `Invalid identifier "${value}": relative path segments are not allowed.`,
      );
    }

    return acc + literal + encoded;
  }, "");
}
