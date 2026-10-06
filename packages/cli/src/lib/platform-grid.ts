/**
 * Renders a flat list of platform identifiers as a 3-column grid.
 *
 * Deliberately kept out of `platforms.ts`: that module is statically
 * imported by `complete.ts`'s shell-completion fast path (no Stricli boot,
 * no heavy deps), and pulling in the markdown/table formatters here would
 * drag chalk/marked/cli-highlight/string-width/wrap-ansi into every
 * `__complete` invocation. Only `project create`'s error message and
 * `platform list` need this rendering — neither is on the completion path.
 */

import { isPlainOutput } from "./formatters/markdown.js";
import { buildMarkdownTable, type Column } from "./formatters/table.js";
import { renderTextTable } from "./formatters/text-table.js";

/** Build a 3-column grid string from a flat list of platforms. */
export function renderPlatformGrid(items: readonly string[]): string {
  const COLS = 3;
  const rows: string[][] = [];
  for (let i = 0; i < items.length; i += COLS) {
    const row = items.slice(i, i + COLS);
    while (row.length < COLS) {
      row.push("");
    }
    rows.push(row);
  }

  if (isPlainOutput()) {
    const columns: Column<string[]>[] = Array.from(
      { length: COLS },
      (_, ci) => ({
        header: " ",
        value: (row: string[]) => row[ci] ?? "",
      })
    );
    return buildMarkdownTable(rows, columns);
  }

  const [first, ...rest] = rows;
  return renderTextTable(first ?? [], rest, {
    headerSeparator: false,
  });
}
