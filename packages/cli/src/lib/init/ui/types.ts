/**
 * WizardUI Abstraction Layer
 *
 * Defines the I/O surface used by the init wizard. Concrete implementations
 * provide the actual rendering:
 *
 * - `InkUI`       — Ink-based React UI. Default for interactive runs on
 *                   both the Bun binary and the npm/Node distribution.
 *                   The Bun binary embeds Ink via `with { type: "file" }`;
 *                   the npm package ships a self-contained ESM sidecar
 *                   (`dist/ink-app.js`) loaded via dynamic `import()`.
 * - `LoggingUI`   — plain stdout/stderr writes for CI, `--yes`, non-TTY
 *                   environments, and the `--no-tui` escape hatch.
 *                   Prompts throw — non-interactive callers must supply
 *                   defaults.
 *
 * The factory in `factory.ts` picks an implementation per run.
 *
 * Goals:
 *   1. Stable prompt API surface so the wizard itself never changes when
 *      we swap implementations.
 *   2. Use a shared cancellation symbol (`CANCELLED`) so all
 *      implementations can signal cancellation uniformly. Callers wrap
 *      prompt results with `abortIfCancelled()` (in `clack-utils.ts`)
 *      which re-throws as `WizardCancelledError`.
 *   3. Stay lean — visual look-and-feel inspiration from PostHog wizard's
 *      `WizardUI` pattern, without the screen router / nanostore / health
 *      check overlays.
 */

import type { InitFeedbackOutcome } from "../feedback.js";

/** Sentinel symbol returned by prompt methods when the user cancels. */
export const CANCELLED: unique symbol = Symbol.for(
  "sentry-cli:wizard-ui:cancelled"
);
export type Cancelled = typeof CANCELLED;

/** Type guard for the shared cancellation sentinel. */
export function isCancelled(value: unknown): value is Cancelled {
  return value === CANCELLED;
}

/**
 * Spinner exit status.
 *
 * - `0` — success (rendered as a green diamond / "Done")
 * - `1` — error   (rendered as a red square)
 * - `2` — warning (rendered as a yellow triangle)
 */
export type SpinnerExitCode = 0 | 1 | 2;

/**
 * Multi-line spinner handle.
 *
 * Mirrors the existing `WizardSpinner` shape in `src/lib/init/spinner.ts`
 * so the long-running suspend/resume loop in `wizard-runner.ts` can swap
 * implementations without changing its control flow.
 */
export type SpinnerHandle = {
  /** Begin spinning with an optional initial message. */
  start(message?: string): void;
  /** Update the message in place while spinning. */
  message(message?: string): void;
  /**
   * Stop spinning and finalize the block with `message`. The exit `code`
   * controls the icon (0 ok, 1 error, 2 warn).
   */
  stop(message?: string, code?: SpinnerExitCode): void;
};

/**
 * Inline log API. Each method renders a single line (or markdown-rendered
 * block, in the case of `message`). In `LoggingUI` these go straight to
 * stdout/stderr; in TUI implementations they accumulate in a scrollable
 * pane.
 */
export type WizardLog = {
  /** Informational — neutral icon. */
  info(message: string): void;
  /** Warning — yellow icon. */
  warn(message: string): void;
  /** Error — red icon. */
  error(message: string): void;
  /** Success — green icon. */
  success(message: string): void;
  /** Plain markdown-rendered block (no icon). */
  message(message: string): void;
};

/** Single option in a `select` / `multiselect` prompt. */
export type SelectOption<T extends string> = {
  /** Machine-readable value returned when the user chooses this option. */
  value: T;
  /** User-facing option label. */
  label: string;
  /** Optional secondary copy rendered beside the label; omitted by default. */
  hint?: string;
};

/** Option in a multiselect prompt, optionally carrying supporting copy or a fixed selection. */
export type MultiSelectOption<T extends string> = SelectOption<T> & {
  /** Product-oriented copy rendered below the label; omitted by default. */
  description?: string;
  /** When true, keeps the option selected and skips it during toggles. Defaults to false. */
  locked?: boolean;
};

/** Supporting row rendered beneath a prompt title. */
export type PromptDetail = {
  /** Text displayed on its own row. */
  text: string;
  /** Semantic color treatment for the row. Defaults to `muted`. */
  tone?: "muted" | "success";
};

/** Args for `select`. */
export type SelectOptions<T extends string> = {
  /** Prompt title shown above the choices. */
  message: string;
  /** Supporting rows rendered below the title; omitted by default. */
  details?: PromptDetail[];
  /** Explanatory copy rendered between details and actions; omitted by default. */
  footer?: PromptDetail;
  /** Choices presented to the user in display order. */
  options: SelectOption<T>[];
  /** Initially highlighted value. Defaults to the first option. */
  initialValue?: T;
};

/** Args for `multiselect`. */
export type MultiSelectOptions<T extends string> = {
  /** Prompt title shown above the choices. */
  message: string;
  /** Supporting rows rendered above a visually separated option list; omitted by default. */
  details?: PromptDetail[];
  /** Choices presented to the user in display order. */
  options: MultiSelectOption<T>[];
  /** Values selected when the prompt mounts. Defaults to an empty list. */
  initialValues?: T[];
  /** Whether at least one value is required before continuing. Defaults to false. */
  required?: boolean;
};

/** Args for `confirm`. */
export type ConfirmOptions = {
  /** Confirmation question shown to the user. */
  message: string;
  /** Initially highlighted answer. Defaults to false. */
  initialValue?: boolean;
};

/** Args for the richer Ink-only welcome screen. */
export type WelcomeOptions = {
  /** Heading shown on the welcome screen. */
  title: string;
  /** Supporting paragraphs shown below the heading. */
  body: string[];
  /** Final call-to-action copy shown above the Continue action. */
  punchline: string;
};

/**
 * Structured completion summary handed to `WizardUI.summary()`.
 *
 * Keeping this as data (vs. pre-rendered markdown) lets each
 * implementation choose its own presentation:
 *   - `LoggingUI` writes a compact two-column key/value listing to
 *     stdout, plus a flat list of changed files.
 *   - `InkUI` mounts a colored panel below the log stream with
 *     proper alignment and per-action glyphs.
 *
 * Previously `formatResult` built terminal markdown and called
 * `ui.log.message(markdown)` — this leaked literal `<color>` tags
 * because the TUI's text renderer had no markdown parser, only a
 * `stripAnsi` step.
 */
export type WizardSummary = {
  /** Flat list of `<label>: <value>` rows (e.g. Platform, Directory). */
  fields: { label: string; value: string }[];
  /** Optional list of files the wizard added/edited/removed. */
  changedFiles?: { action: string; path: string }[];
  /** AI-generated per-feature blurbs personalised to the analysed project. */
  featureBlurbs?: { label: string; blurb: string }[];
  /**
   * Structured data for the interactive completion screen (InkUI only).
   * `LoggingUI` ignores it — the flat `fields` above cover the non-TTY case.
   */
  completion?: WizardCompletion;
};

/**
 * Everything the interactive exit screen needs to turn "we changed some files"
 * into "go see your first error" — one first-error hero plus a menu of next
 * steps (open Issues, install the MCP / agent plugin, read the docs).
 */
export type WizardCompletion = {
  /** Human-facing project name shown in the header. */
  projectName: string;
  /** Enabled-feature display labels, e.g. ["Errors", "Tracing", "Replay"]. */
  features: string[];
  /**
   * AI-written one-liner per enabled feature ("what we set up"). Empty when
   * the blurb agent didn't run; the screen then falls back to plain labels.
   */
  featureBlurbs: { label: string; blurb: string }[];
  /** Number of files the wizard created/edited. */
  changedFileCount: number;
  /** Project-scoped Issues stream — the primary call-to-action. */
  issuesUrl?: string;
  /**
   * Verification outcome. `received` is true when init's verify step caught an
   * event; `eventUrl` deep-links that exact event when its id was captured.
   */
  verification: { received: boolean; eventUrl?: string };
  /** Command that installs the Sentry coding-agent plugin. */
  agentInstallCommand?: string;
  /** Best-effort "start your app" command shown in the recipe, e.g. "pnpm dev". */
  startCommand?: string;
};

/**
 * A completion-screen interaction worth recording on the run's telemetry.
 * `open-sentry` covers both the "View my first event" / "Open my Issues feed"
 * menu item and the `o` shortcut; the agent-plugin events track the install
 * toggle (a queued click is the "did they choose to install the plugin" signal).
 */
export type CompletionActionEvent =
  | "open-sentry"
  | "agent-plugin-queued"
  | "agent-plugin-unqueued";

/**
 * Side-effectful actions the completion screen invokes. Provided by `InkUI`
 * (which lives in the main bundle) so the pre-bundled Ink sidecar never has to
 * import Node built-ins (browser launch) or the Sentry SDK itself.
 */
export type CompletionActions = {
  /** Open a URL in the user's browser. Best-effort, non-blocking. */
  openUrl: (url: string) => void;
  /**
   * Record a completion-screen interaction on the run's telemetry. Bound by
   * `InkUI` so the Ink sidecar never imports Sentry; the tags land on the
   * active `cli.command` transaction like the rest of the `wizard.*` tags.
   */
  track: (event: CompletionActionEvent) => void;
};

/**
 * The full I/O surface used by the init wizard.
 *
 * Implementations MUST be safe to dispose via the async dispose protocol —
 * `using ui = getUI(...)` semantics in callers tear down renderers, restore
 * the main screen buffer, and release any held TTY resources.
 */
export type WizardUI = AsyncDisposable & {
  // ── Lifecycle messages ────────────────────────────────────────────

  /**
   * Display the multi-line ASCII banner. Implementations decide where
   * the banner appears: `InkUI` paints it from a pre-loaded gradient
   * inside its layout (the call is a no-op there), while `LoggingUI`
   * writes the pre-styled ANSI string to stderr. Always called once,
   * before `intro()`.
   */
  banner(art: string): void;

  /** Display the wizard intro banner / heading. */
  intro(title: string): void;

  /**
   * Render a structured completion summary. See {@link WizardSummary}.
   * Implementations are free to choose layout — there's no markdown
   * involved so the Ink renderer doesn't have to parse anything.
   */
  summary(summary: WizardSummary): void;

  /** Display the success outro line. Called on a successful run. */
  outro(message: string): void;

  /**
   * Display a cancellation outro line. Called on user-cancelled or aborted
   * runs (analogous to clack's `cancel()`).
   */
  cancel(message: string): void;

  /** Display an outcome-specific feedback prompt after a terminal outcome. */
  feedback(outcome: InitFeedbackOutcome): void;

  /**
   * Notify the UI that the wizard is reading the listed files from
   * disk. Optional — implementations that don't track reads (e.g.
   * `LoggingUI`) leave this undefined. `InkUI` uses it to drive both
   * the inline file-read status line on narrow terminals and the
   * sidebar `FilesPanel` tree on wider ones, so the user can see what
   * context the AI looked at instead of losing it in a half-second
   * spinner flash.
   */
  recordFilesReading?(paths: string[]): void;

  /**
   * Notify the UI that the previously-recorded files have finished
   * being analyzed. Same optional contract as `recordFilesReading`.
   */
  markFilesAnalyzed?(paths: string[]): void;

  /**
   * Notify the UI that a workflow step has changed status. Optional —
   * `LoggingUI` leaves this undefined since the running log already
   * narrates progress. `InkUI` uses it to drive the static progress
   * checklist in the sidebar.
   *
   * Status semantics:
   *   - `"in_progress"` — the runner just suspended on this step.
   *     Idempotent: a step that suspends multiple times (read-files
   *     followed by analyze, etc.) only flips to in_progress once.
   *   - `"completed"`   — the runner has resumed past this step.
   *   - `"failed"`      — the runner aborted while this step was
   *     active.
   *   - `"skipped"`     — the workflow's branching skipped this step
   *     entirely. In practice the store back-fills this implicitly
   *     when a later step starts, so callers rarely need to pass it.
   */
  setStep?(
    stepId: string,
    status: "in_progress" | "completed" | "failed" | "skipped"
  ): void;

  /**
   * Show a non-blocking overlay (e.g. health/retry status).
   * Optional — `LoggingUI` leaves this undefined.
   */
  setOverlay?(overlay: {
    kind: string;
    message: string;
    retryCount: number;
  }): void;

  /** Clear the active overlay. */
  clearOverlay?(): void;

  /**
   * Keep rendering the lightweight intro layout while local preflight
   * prompts/checks run. Ink uses this to keep git/org/project/team prompts
   * centered with the opening copy until the remote workflow starts.
   */
  setIntroMode?(enabled: boolean): void;

  // ── Logging ───────────────────────────────────────────────────────

  log: WizardLog;

  // ── Spinner ───────────────────────────────────────────────────────

  /**
   * Create a fresh spinner handle. Implementations may share a single
   * underlying spinner widget across calls — callers should not assume
   * each `spinner()` returns an independent renderable.
   */
  spinner(): SpinnerHandle;

  // ── Prompts ───────────────────────────────────────────────────────

  /**
   * Single-choice select. Returns the selected value, or {@link CANCELLED}
   * if the user aborted (Ctrl+C / Escape).
   */
  select<T extends string>(opts: SelectOptions<T>): Promise<T | Cancelled>;

  /**
   * Multi-choice select. Returns the selected values, or {@link CANCELLED}
   * if the user aborted.
   */
  multiselect<T extends string>(
    opts: MultiSelectOptions<T>
  ): Promise<T[] | Cancelled>;

  /**
   * Yes/no confirm. Returns the boolean answer, or {@link CANCELLED} if
   * the user aborted.
   */
  confirm(opts: ConfirmOptions): Promise<boolean | Cancelled>;

  /**
   * Richer Ink-only opening screen. Plain UIs leave this undefined and
   * callers fall back to `select()`.
   */
  welcome?(opts: WelcomeOptions): Promise<"continue" | Cancelled>;
};
