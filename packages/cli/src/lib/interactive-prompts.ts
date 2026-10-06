/**
 * Process-wide gate for interactive prompts.
 *
 * Commands that emit machine-readable output or explicitly run unattended
 * (`--json`, `--yes`, or `--dry-run`) must never block on an interactive prompt.
 * The command wrapper disables prompts from parsed flag values via
 * {@link setInteractivePromptsAllowed}, and prompt sites (e.g. the org/project
 * picker in `resolve-target.ts`) consult {@link interactivePromptsAllowed}.
 *
 * Defaults to `true` so code paths that run outside the command wrapper (tests,
 * library callers) fall back to their own TTY checks rather than being silently
 * blocked.
 */

let allowed = true;

/**
 * Enable or disable interactive prompts for the current command run. Called by
 * the command wrapper with `false` when JSON output is active.
 */
export function setInteractivePromptsAllowed(value: boolean): void {
  allowed = value;
}

/** Whether interactive prompts are currently permitted. */
export function interactivePromptsAllowed(): boolean {
  return allowed;
}
