/**
 * WizardUI Factory
 *
 * Picks the appropriate `WizardUI` implementation based on runtime
 * environment and CLI flags. This is the single chokepoint for UI
 * selection — every part of the init wizard goes through `getUIAsync()`
 * rather than instantiating implementations directly.
 *
 * Selection priority (highest first):
 *
 * 1. `--yes` flag set, OR stdin/stdout is not a TTY — `LoggingUI`
 *    (CI / piped input). Prompt methods throw, so callers must
 *    pre-resolve every choice up-front.
 * 2. `SENTRY_INIT_TUI=0` or `--no-tui` — `LoggingUI`. Acts as a debug
 *    escape hatch when the Ink path misbehaves. In an interactive
 *    context this means the wizard becomes effectively non-interactive
 *    (any prompt aborts), so users hitting this path will need to set
 *    every choice via flags or rely on auto-detection.
 * 3. Default (interactive, no opt-out) — `InkUI`. Works on both the
 *    Bun binary (Ink embedded via `with { type: "file" }`) and the
 *    npm/Node distribution (self-contained ESM sidecar loaded via
 *    dynamic `import()`). Falls back to `LoggingUI` if the import
 *    fails for any reason.
 *
 * Implementation history:
 *   - PR 4: replaced `ClackUI` with `OpenTuiUI` as the default.
 *   - This PR: replaced `OpenTuiUI` with `InkUI`. OpenTUI's Zig
 *     bindings added ~10.7 MB to the compiled binary; Ink + React +
 *     companions add a fraction of that and use no native code.
 */

import { LoggingUI } from "./logging-ui.js";
import type { WelcomeOptions, WizardUI } from "./types.js";

/**
 * Inputs that affect UI selection. Mirrors the relevant subset of
 * `WizardOptions` so we don't drag the full type into the factory.
 */
export type UIFactoryOptions = {
  /** True when `--yes` (or `--dry-run`, which implies non-interactive) is set. */
  yes: boolean;
  /**
   * Optional first Ink prompt to seed before `ink.render()` is called.
   * This keeps the first painted frame from flashing the normal wizard
   * shell before the welcome screen is ready.
   */
  initialWelcome?: WelcomeOptions;
  /**
   * True when the user explicitly opted out of the new TUI via
   * `--no-tui`. Forces `LoggingUI`.
   */
  forceLegacy?: boolean;
};

/**
 * Detect whether the current process can run an interactive prompt.
 * Both stdin (read keystrokes) and stdout (render the prompt) must be
 * TTYs. Piped input or output disqualifies us.
 *
 * Exported for the test suite.
 */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/**
 * Returns `true` when the `LoggingUI` should be used — i.e. we're in
 * a non-interactive context, the user opted out of the TUI, or the
 * env var override is set.
 */
function shouldUseLogging(opts: UIFactoryOptions): boolean {
  if (process.env.SENTRY_INIT_TUI === "0") {
    return true;
  }
  if (opts.forceLegacy) {
    return true;
  }
  if (opts.yes) {
    return true;
  }
  if (!isInteractiveTerminal()) {
    return true;
  }
  return false;
}

/**
 * Async factory — picks `InkUI` for interactive runs, otherwise
 * `LoggingUI`. Works on both the Bun binary and the npm/Node
 * distribution (the Ink sidecar is self-contained ESM loaded via
 * dynamic `import()`). Falls back to `LoggingUI` if the Ink import
 * fails for any reason.
 *
 * Callers should treat the return value as an `AsyncDisposable` and
 * use `await using ui = await getUIAsync(...)` to guarantee teardown
 * on every exit path.
 */
export async function getUIAsync(opts: UIFactoryOptions): Promise<WizardUI> {
  if (shouldUseLogging(opts)) {
    return new LoggingUI();
  }
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const { createInkUI } = await import("./ink-ui.js");
    return await createInkUI({ initialWelcome: opts.initialWelcome });
  } catch {
    // Fall through to LoggingUI so a missing/broken sidecar
    // doesn't take down the wizard. Unreachable on a correctly
    // built package — safety net for corrupted installs.
    return new LoggingUI();
  }
}
