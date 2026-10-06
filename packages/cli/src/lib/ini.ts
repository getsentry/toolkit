/**
 * Simple INI file parser.
 *
 * Supports the subset of INI syntax used by `.sentryclirc` config files:
 * `[section]` headers, `key = value` pairs, and `#`/`;` line comments.
 *
 * Design decisions:
 * - Section and key names are lowercased for case-insensitive lookup
 * - Inline comments are NOT supported (tokens/URLs may contain `#` and `;`)
 * - Duplicate keys: last value wins within a section
 * - Duplicate sections: merged (keys accumulate)
 * - Malformed lines are silently skipped
 * - Quoted values (matching `"` or `'`) are stripped
 */

import { logger } from "./logger.js";

const log = logger.withTag("ini");

/** Parsed INI data: section name → key → value. Keys before any section go into `""`. */
export type IniData = Record<string, Record<string, string>>;

/** UTF-8 BOM character */
const BOM = "\uFEFF";

/** Match `[section]` headers, allowing whitespace inside brackets */
const SECTION_RE = /^\[([^\]]+)\]$/;

/** Split on LF or CRLF in one pass */
const LINE_SPLIT_RE = /\r?\n/;

/**
 * Strip matching outer quotes from a value string.
 *
 * Only strips when the first and last characters are the same quote type
 * (`"` or `'`) and the string is at least 2 characters long.
 */
function stripQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value.at(-1);
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse INI-formatted text into a section→key→value map.
 *
 * @param content - Raw INI file content
 * @returns Parsed data keyed by lowercase section name, then lowercase key
 */
export function parseIni(content: string): IniData {
  const data: IniData = {};
  let currentSection = "";

  // Ensure the global section always exists
  data[currentSection] = {};

  // Strip UTF-8 BOM if present
  const text = content.startsWith(BOM) ? content.slice(1) : content;

  for (const rawLine of text.split(LINE_SPLIT_RE)) {
    const line = rawLine.trim();

    // Skip empty lines and comments (lines starting with # or ;)
    if (line === "" || line[0] === "#" || line[0] === ";") {
      continue;
    }

    // Check for section header
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch?.[1]) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      if (!(currentSection in data)) {
        data[currentSection] = {};
      }
      continue;
    }

    // Check for key = value pair
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      log.debug(`Skipping malformed INI line: ${line}`);
      continue;
    }

    const key = line.slice(0, eqIndex).trim().toLowerCase();
    if (key === "") {
      log.debug(`Skipping INI line with empty key: ${line}`);
      continue;
    }

    const rawValue = line.slice(eqIndex + 1).trim();
    const value = stripQuotes(rawValue);

    // biome-ignore lint/style/noNonNullAssertion: section is always initialized above
    data[currentSection]![key] = value;
  }

  return data;
}
