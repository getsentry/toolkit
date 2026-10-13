/** Text filtering and editing for entity selection prompts. */

import { stripAnsi } from "../../formatters/plain-detect.js";
import type { SelectOption } from "./types.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const NON_PRINTABLE_INPUT = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/** Match names, slugs, and visible hints without changing the option order. */
export function filterSelectOptions<T extends SelectOption<string>>(
  options: readonly T[],
  query: string,
): readonly T[] {
  if (query === "") {
    return options;
  }

  const needle = query.toLowerCase();
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.value.toLowerCase().includes(needle) ||
      option.hint?.toLowerCase().includes(needle),
  );
}

/** Keep pasted input on one line and prevent terminal sequences in the filter. */
export function sanitizeSelectFilterInput(input: string): string {
  return stripAnsi(input).replace(NON_PRINTABLE_INPUT, "");
}

/** Backspace removes one displayed character, including combined emoji. */
export function removeLastFilterCharacter(query: string): string {
  const lastCharacter = graphemeSegmenter
    .segment(query)
    .containing(query.length - 1);
  return query.slice(0, lastCharacter?.index ?? 0);
}
