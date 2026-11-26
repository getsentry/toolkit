/**
 * The fuzzy-filter select picker (org/project and account selection).
 */

import { isatty } from "node:tty";
import type { SelectOptions } from "./select-ui/types.js";
import { interactivePromptsAllowed } from "./interactive-prompts.js";

/**
 * Whether the picker can run: prompts are allowed, and stdin and stdout are
 * terminals.
 */
export function canShowSelectPrompt(): boolean {
  return interactivePromptsAllowed() && isatty(0) && isatty(1);
}

/**
 * Let the user filter and pick one option. Returns the selected value, or
 * `null` when the prompt is cancelled. Check {@link canShowSelectPrompt}
 * first.
 */
export async function selectWithFilter(
  opts: SelectOptions<string>,
): Promise<string | null> {
  const terminal = await import("./select-ui/terminal.js");
  return await terminal.selectWithFilter(opts);
}
