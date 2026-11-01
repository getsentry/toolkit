/** The flat fields that the JSON and logfmt reporters write. */

import { LOG_LEVEL_NAMES } from "./levels.js";
import { formatMessage } from "./message.js";
import type { LogAttributeValue, LogRecord } from "./types.js";

/** Field names the reporters own. Attributes with these names are dropped. */
const BUILT_IN_FIELDS = new Set(["time", "level", "type", "tag", "msg"]);

/** The second {@link isoTime} last formatted, and its text before the milliseconds. */
let cachedSecond = Number.NaN;
let cachedPrefix = "";

/**
 * `date.toISOString()`, formatting each second only once. `toISOString()`
 * costs more than the rest of a JSON line, and log lines mostly share a
 * second.
 */
function isoTime(date: Date): string {
  const time = date.getTime();
  const second = Math.floor(time / 1000);
  if (second !== cachedSecond) {
    cachedSecond = second;
    // Drop "mmmZ"; years outside 0000-9999 make the rest longer.
    cachedPrefix = new Date(second * 1000).toISOString().slice(0, -4);
  }
  const ms = time - second * 1000;
  return `${cachedPrefix}${ms < 10 ? "00" : ms < 100 ? "0" : ""}${ms}Z`;
}

/**
 * A record as an object with ordered fields: `time` (ISO 8601), `level`
 * (`error`, `warn`, `log`, `info`, `debug`, or `trace`), `type` when it differs
 * from the level (such as `success`), `tag` when set, `msg`, and then the
 * record's attributes.
 */
export function recordFields(
  record: LogRecord,
): Record<string, LogAttributeValue> {
  const level = LOG_LEVEL_NAMES[record.level] ?? "info";
  const fields: Record<string, LogAttributeValue> = {
    time: isoTime(record.date),
    level,
  };
  if (record.type !== level) {
    fields.type = record.type;
  }
  if (record.tag) {
    fields.tag = record.tag;
  }
  fields.msg = formatMessage(record.args, { stack: true });
  const { attributes } = record;
  for (const key of Object.keys(attributes)) {
    if (BUILT_IN_FIELDS.has(key)) {
      continue;
    }
    const value = attributes[key] as LogAttributeValue;
    if (key === "__proto__") {
      // Assigning `__proto__` would set the prototype instead of a field.
      Object.defineProperty(fields, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      fields[key] = value;
    }
  }
  return fields;
}
