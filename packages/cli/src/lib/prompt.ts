/**
 * Interactive terminal prompts, backed by `@clack/prompts`.
 *
 * `@clack/prompts` loads only when a command asks a question, and never in the
 * shell completion bundle.
 *
 * @module
 */

/** Options for a yes/no prompt. */
type ConfirmPromptOptions = { type: "confirm"; initial?: boolean };

/** Options for a free-text prompt. */
type TextPromptOptions = {
  type: "text";
  placeholder?: string;
  initial?: string;
  default?: string;
};

/**
 * Set to `true` by esbuild in the `dist/complete.cjs` bundle (see
 * `script/bundle.ts`), so the `@clack/prompts` import below stays out of the
 * shell completion bundle. Undefined when running from source.
 */
declare const SENTRY_CLI_COMPLETION_BUILD: boolean | undefined;

/**
 * Ask the user a question on the terminal.
 *
 * Resolves to the answer, or to clack's cancel symbol when the user presses
 * Ctrl+C, so callers check for `=== true` or `typeof answer === "string"`.
 */
export function prompt(
  message: string,
  opts: ConfirmPromptOptions,
): Promise<boolean | symbol>;
export function prompt(
  message: string,
  opts: TextPromptOptions,
): Promise<string | symbol>;
export async function prompt(
  message: string,
  opts: ConfirmPromptOptions | TextPromptOptions,
): Promise<boolean | string | symbol> {
  if (
    typeof SENTRY_CLI_COMPLETION_BUILD !== "undefined" &&
    SENTRY_CLI_COMPLETION_BUILD
  ) {
    throw new Error("Prompts are not available during shell completion.");
  } else {
    // The `else` lets esbuild drop this import from the completion bundle.
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
}
