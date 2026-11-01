/** The flat fields that the JSON and logfmt reporters write. */

import { LOG_LEVEL_NAMES } from "./levels.js";
import { formatMessage } from "./message.js";
import type { LogAttributeValue, LogRecord } from "./types.js";

/** Field names the reporters own. Attributes with these names are dropped. */
const BUILT_IN_FIELDS = new Set(["time", "level", "type", "tag", "msg"]);

/**
 * A record as ordered key-value pairs: `time` (ISO 8601), `level` (`error`,
 * `warn`, `log`, `info`, `debug`, or `trace`), `type` when it differs from the
 * level (such as `success`), `tag` when set, `msg`, and then the record's
 * attributes.
 */
export function recordFields(record: LogRecord): [string, LogAttributeValue][] {
  const level = LOG_LEVEL_NAMES[record.level] ?? "info";
  const fields: [string, LogAttributeValue][] = [
    ["time", record.date.toISOString()],
    ["level", level],
  ];
  if (record.type !== level) {
    fields.push(["type", record.type]);
  }
  if (record.tag) {
    fields.push(["tag", record.tag]);
  }
  fields.push(["msg", formatMessage(record.args, { stack: true })]);
  for (const [key, value] of Object.entries(record.attributes)) {
    if (!BUILT_IN_FIELDS.has(key)) {
      fields.push([key, value]);
    }
  }
  return fields;
}
