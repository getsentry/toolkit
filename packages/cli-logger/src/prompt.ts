/**
 * A {@link Prompt} backed by `@clack/prompts`, for `createLogger({ prompt })`.
 *
 * It lives in its own entry point so the logger itself never references
 * `@clack/prompts`. `@clack/prompts` loads only when a prompt runs.
 *
 * @module
 */

import type {
  ConfirmPromptOptions,
  Prompt,
  TextPromptOptions,
} from "./types.js";

/**
 * Ask with `@clack/prompts`. Resolves to the answer, or to clack's cancel
 * symbol when the user presses Ctrl+C.
 */
function ask(
  message: string,
  opts: ConfirmPromptOptions,
): Promise<boolean | symbol>;
function ask(
  message: string,
  opts: TextPromptOptions,
): Promise<string | symbol>;
async function ask(
  message: string,
  opts: ConfirmPromptOptions | TextPromptOptions,
): Promise<boolean | string | symbol> {
  const clack = await import("@clack/prompts");
  if (opts.type === "confirm") {
    return await clack.confirm({ message, initialValue: opts.initial });
  }
  return await clack.text({
    message,
    placeholder: opts.placeholder,
    initialValue: opts.initial,
    defaultValue: opts.default,
  });
}

export const clackPrompt: Prompt = ask;
