/** Shared arguments for external issue association commands. */

import { ValidationError } from "../../lib/errors.js";
import { issueIdPositional } from "./utils.js";

/** Required source issue and existing external resource URL for link and unlink. */
export const EXTERNAL_ISSUE_POSITIONALS = {
  kind: "tuple",
  parameters: [
    ...issueIdPositional.parameters,
    {
      placeholder: "url",
      parse: String,
      brief: "URL of an existing tracker issue or GitHub pull request",
    },
  ],
} as const;

/** Flags identifying an existing external issue and its Sentry integration. */
export const EXTERNAL_ISSUE_FLAGS = {
  integration: {
    kind: "parsed",
    parse: String,
    brief: "Native integration ID, when multiple installations match",
    optional: true,
  },
  app: {
    kind: "parsed",
    parse: String,
    brief: "Sentry App slug (automatically detected for Linear URLs)",
    optional: true,
  },
} as const;

/** Parse repeated App form fields while rejecting ambiguous duplicate keys. */
export function parseIssueLinkFields(
  fields: readonly string[] | undefined
): Record<string, string> | undefined {
  if (!fields?.length) {
    return;
  }
  const result: Record<string, string> = {};
  for (const field of fields) {
    const separator = field.indexOf("=");
    const key = field.slice(0, separator);
    if (
      separator < 1 ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      Object.hasOwn(result, key)
    ) {
      throw new ValidationError(
        "Each --field must be a unique name=value pair."
      );
    }
    result[key] = field.slice(separator + 1);
  }
  return result;
}
