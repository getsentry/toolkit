/**
 * The fuzzy-filter select picker (org/project and account selection).
 *
 * The picker runs on Ink, which the `@sentry/mcp-server` bundle leaves out by
 * setting `define: { __SENTRY_CLI_INK_UI__: "false" }`. esbuild then drops
 * the picker's import with its dead branch, and callers take the same path as
 * in a non-interactive terminal.
 */

import { isatty } from "node:tty";
import type { SelectOptions } from "./init/ui/types.js";
import { interactivePromptsAllowed } from "./interactive-prompts.js";

/** Build-time switch; undefined (enabled) outside bundles that define it. */
declare const __SENTRY_CLI_INK_UI__: boolean | undefined;

/**
 * Whether the picker can run: this build has the Ink UI, prompts are
 * allowed, and stdin and stdout are terminals.
 */
export function canShowSelectPrompt(): boolean {
  return (
    (typeof __SENTRY_CLI_INK_UI__ === "undefined" || __SENTRY_CLI_INK_UI__) &&
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
  if (typeof __SENTRY_CLI_INK_UI__ === "undefined" || __SENTRY_CLI_INK_UI__) {
    const ink = await import("./init/ui/ink-ui.js");
    return await ink.selectWithFilter(opts);
  }
  return null;
}
