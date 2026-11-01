/** logfmt lines (`key=value key="quoted value"`), one per log call. */

import { recordFields } from "../fields.js";
import type { LogAttributeValue, Reporter } from "../types.js";
import type { StreamReporterOptions } from "./json.js";

/** Values that need quotes: empty, or holding a space, `=`, `"`, `\`, or a control character. */
// oxlint-disable-next-line no-control-regex -- control characters must be quoted
const NEEDS_QUOTES = /^$|[\s="\\\x00-\x1f\x7f]/;

/** Characters escaped inside a quoted value. */
// oxlint-disable-next-line no-control-regex -- control characters must be escaped
const ESCAPED = /["\\\x00-\x1f\x7f]/g;

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Characters a logfmt key cannot hold: a space, `=`, `"`, or a control
 * character. Everything else, `.` included, passes through, as in
 * go-logfmt and node-logfmt.
 */
// oxlint-disable-next-line no-control-regex -- control characters must be replaced
const INVALID_KEY_CHARACTER = /[\s="\x00-\x1f\x7f]/;
const INVALID_KEY_CHARACTERS = new RegExp(INVALID_KEY_CHARACTER.source, "g");

/** `key` with invalid characters replaced by `_`. Most keys need no replacing. */
function formatKey(key: string): string {
  return INVALID_KEY_CHARACTER.test(key)
    ? key.replace(INVALID_KEY_CHARACTERS, "_")
    : key;
}

function formatValue(value: LogAttributeValue): string {
  const text = String(value);
  if (!NEEDS_QUOTES.test(text)) {
    return text;
  }
  const escaped = text.replace(
    ESCAPED,
    (char) =>
      ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `"${escaped}"`;
}

/**
 * A reporter that writes each log call as one logfmt line:
 *
 * ```text
 * time=2026-01-15T14:28:59.000Z level=info tag=auth msg="Logged in" user=jane
 * ```
 */
export function logfmtReporter(options: StreamReporterOptions = {}): Reporter {
  return {
    log(record) {
      const fields = recordFields(record);
      let line = "";
      for (const key of Object.keys(fields)) {
        line += `${line ? " " : ""}${formatKey(key)}=${formatValue(fields[key] as LogAttributeValue)}`;
      }
      (options.stream ?? process.stderr).write(`${line}\n`);
    },
  };
}
