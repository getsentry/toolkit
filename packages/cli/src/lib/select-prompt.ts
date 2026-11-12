/**
 * The fuzzy-filter select picker (org/project and account selection).
 *
 * The `@sentry/mcp-server` bundle leaves the picker out by setting
 * `define: { __SENTRY_CLI_SELECT_UI__: "false" }`. esbuild then drops the
 * picker's import with its dead branch, and callers take the same path as in
 * a non-interactive terminal.
 */

import { isatty } from "node:tty";
import type { SelectOptions } from "./select-ui/types.js";
import { interactivePromptsAllowed } from "./interactive-prompts.js";

/** Build-time switch; undefined (enabled) outside bundles that define it. */
declare const __SENTRY_CLI_SELECT_UI__: boolean | undefined;

/**
 * Whether the picker can run: this build has the picker, prompts are
 * allowed, and stdin and stdout are terminals.
 */
export function canShowSelectPrompt(): boolean {
  return (
    (typeof __SENTRY_CLI_SELECT_UI__ === "undefined" ||
      __SENTRY_CLI_SELECT_UI__) &&
    interactivePromptsAllowed() &&
    isatty(0) &&
    isatty(1)
  );
}

/**
 * Let the user filter and pick one option. Returns the selected value, or
 * `null` when the prompt is cancelled. Check {@link canShowSelectPrompt}
 * first.
 */
export async function selectWithFilter(
  opts: SelectOptions<string>,
): Promise<string | null> {
  if (
    typeof __SENTRY_CLI_SELECT_UI__ === "undefined" ||
    __SENTRY_CLI_SELECT_UI__
  ) {
    const terminal = await import("./select-ui/terminal.js");
    return await terminal.selectWithFilter(opts);
  }
  return null;
}
