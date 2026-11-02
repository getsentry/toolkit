function isHighSurrogate(code: number): boolean {
  return code >= 0xd8_00 && code <= 0xdb_ff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc_00 && code <= 0xdf_ff;
}

/**
 * Slice `text` like `String.prototype.slice` without splitting a surrogate pair.
 *
 * Truncating user text (log messages, breadcrumbs, prompts) by UTF-16 index can
 * cut an emoji in half. The lone half serializes as `\ud83d`, and strict JSON
 * parsers such as serde_json reject the whole response. When a bound lands
 * inside a pair, this drops the partial character: `end` backs off one unit
 * and `start` moves forward one unit.
 */
export function sliceAtCodePointBoundary(
  text: string,
  start: number,
  end: number = text.length,
): string {
  const length = text.length;
  let from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
  let to = end < 0 ? Math.max(length + end, 0) : Math.min(end, length);

  if (
    from > 0 &&
    from < length &&
    isLowSurrogate(text.charCodeAt(from)) &&
    isHighSurrogate(text.charCodeAt(from - 1))
  ) {
    from += 1;
  }
  if (
    to > 0 &&
    to < length &&
    isHighSurrogate(text.charCodeAt(to - 1)) &&
    isLowSurrogate(text.charCodeAt(to))
  ) {
    to -= 1;
  }

  return text.slice(from, to);
}
