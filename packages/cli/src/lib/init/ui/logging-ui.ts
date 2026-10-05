/**
 * LoggingUI — non-interactive WizardUI implementation.
 *
 * Used in CI, with `--yes`, when stdin/stdout is not a TTY, or when the
 * user explicitly opts out via `SENTRY_INIT_TUI=0`. Output is plain text
 * written directly to stdout/stderr — no ANSI control sequences, no
 * spinners, no alternate screen buffer, no prompt rendering.
 *
 * Prompt methods (`select`, `multiselect`, `confirm`) throw a
 * `LoggingUIPromptError`. Callers MUST resolve all interactive choices
 * (org, project, team, features, confirmations) up-front through CLI
 * flags or `--yes` defaults before invoking any UI prompt method. This
 * mirrors PostHog wizard's approach: in CI, the I/O layer cannot fall
 * back to stdin reads.
 *
 * The spinner is a no-op shape — `start`/`message`/`stop` log key
 * transitions but do not render an animated indicator. This keeps CI
 * logs deterministic and free of carriage returns.
 */

import {
  renderInlineMarkdown,
  renderMarkdown,
} from "../../formatters/markdown.js";
import { renderTextTable } from "../../formatters/text-table.js";
import { formatFeedbackHint, type InitFeedbackOutcome } from "../feedback.js";
import { buildFileTree, flattenTree } from "./file-tree.js";
import type {
  ConfirmOptions,
  MultiSelectOptions,
  SelectOptions,
  SpinnerExitCode,
  SpinnerHandle,
  WizardLog,
  WizardSummary,
  WizardUI,
} from "./types.js";

/**
 * Thrown when an interactive prompt is invoked under `LoggingUI`.
 *
 * The wizard runs in a non-interactive context and the caller did not
 * pre-resolve the choice. The message identifies which prompt was
 * unexpectedly reached so it can be surfaced as a setup error.
 */
export class LoggingUIPromptError extends Error {
  constructor(
    promptKind: "select" | "multiselect" | "confirm",
    message: string
  ) {
    super(
      `Cannot show ${promptKind} prompt in non-interactive mode: ${message}. ` +
        "Pass --yes or provide the value via CLI flags / environment variables."
    );
    this.name = "LoggingUIPromptError";
  }
}

/**
 * Optional configuration for `LoggingUI`. Mainly used by tests to redirect
 * output away from the real `process.stdout`/`process.stderr`.
 */
export type LoggingUIOptions = {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
};

const DEFAULT_OPTIONS: Required<LoggingUIOptions> = {
  stdout: process.stdout,
  stderr: process.stderr,
};

/**
 * Plain stdout/stderr WizardUI. See module doc for behavior.
 */
export class LoggingUI implements WizardUI {
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;

  constructor(options: LoggingUIOptions = {}) {
    this.stdout = options.stdout ?? DEFAULT_OPTIONS.stdout;
    this.stderr = options.stderr ?? DEFAULT_OPTIONS.stderr;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  banner(_art: string): void {
    // No-op — LoggingUI is used in non-TTY / CI contexts where the
    // large ASCII banner wastes vertical space and adds noise for
    // programmatic consumers (agents, scripts, piped output).
  }

  intro(title: string): void {
    this.writeLine(this.stdout, title);
  }

  summary(summary: WizardSummary): void {
    if (
      summary.fields.length === 0 &&
      !summary.changedFiles?.length &&
      !summary.featureBlurbs?.length
    ) {
      return;
    }
    // Compact two-column key/value listing — one line per field. The
    // label is right-padded to a stable width so the values align in
    // the user's terminal even without a tabulated renderer.
    const labelWidth = Math.max(
      ...summary.fields.map((field) => field.label.length),
      0
    );
    this.writeLine(this.stdout, "");
    for (const field of summary.fields) {
      const padded = field.label.padEnd(labelWidth);
      this.writeLine(this.stdout, `  ${padded}  ${field.value}`);
    }
    if (summary.featureBlurbs && summary.featureBlurbs.length > 0) {
      this.writeLine(this.stdout, "");
      this.writeLine(this.stdout, "  Here's what we set up");
      const tableRows = summary.featureBlurbs.map(({ label, blurb }) => [
        label,
        blurb,
      ]);
      const table = renderTextTable(["", ""], tableRows, {
        shrinkable: [false, true],
      });
      for (const line of table.trimEnd().split("\n")) {
        this.writeLine(this.stdout, `  ${line}`);
      }
    }
    if (summary.changedFiles && summary.changedFiles.length > 0) {
      this.writeLine(this.stdout, "");
      this.writeLine(this.stdout, "  Changed files:");
      // Render as a directory tree so collapsed common prefixes match
      // what the InkUI panel + post-dispose summary report show.
      const tree = buildFileTree(summary.changedFiles);
      for (const row of flattenTree(tree)) {
        this.writeLine(this.stdout, `    ${formatTreeRowPlain(row)}`);
      }
    }
  }

  outro(message: string): void {
    this.writeLine(this.stdout, message);
  }

  cancel(message: string): void {
    this.writeLine(this.stderr, message);
  }

  feedback(outcome: InitFeedbackOutcome): void {
    this.writeLine(this.stdout, formatFeedbackHint(outcome));
    this.writeLine(this.stdout, "");
  }

  // ── Logging ───────────────────────────────────────────────────────

  log: WizardLog = {
    info: (message: string) =>
      this.writeLine(this.stdout, `info: ${this.renderInline(message)}`),
    warn: (message: string) =>
      this.writeLine(this.stderr, `warn: ${this.renderInline(message)}`),
    error: (message: string) =>
      this.writeLine(this.stderr, `error: ${this.renderInline(message)}`),
    success: (message: string) =>
      this.writeLine(this.stdout, `ok: ${this.renderInline(message)}`),
    message: (message: string) =>
      this.writeLine(this.stdout, renderMarkdown(message)),
  };

  // ── Spinner (no-op renderer; logs lifecycle transitions) ──────────

  spinner(): SpinnerHandle {
    let active = false;
    return {
      start: (message?: string) => {
        active = true;
        if (message) {
          this.writeLine(this.stdout, this.renderInline(message));
        }
      },
      message: (message?: string) => {
        if (active && message) {
          this.writeLine(this.stdout, this.renderInline(message));
        }
      },
      stop: (message?: string, code: SpinnerExitCode = 0) => {
        if (!active) {
          return;
        }
        active = false;
        if (message) {
          const stream = code === 1 ? this.stderr : this.stdout;
          const prefix = stopPrefix(code);
          this.writeLine(stream, `${prefix} ${this.renderInline(message)}`);
        }
      },
    };
  }

  // ── Prompts (throw — caller must pre-resolve) ─────────────────────

  select<T extends string>(opts: SelectOptions<T>): Promise<T> {
    return Promise.reject(new LoggingUIPromptError("select", opts.message));
  }

  multiselect<T extends string>(opts: MultiSelectOptions<T>): Promise<T[]> {
    return Promise.reject(
      new LoggingUIPromptError("multiselect", opts.message)
    );
  }

  confirm(opts: ConfirmOptions): Promise<boolean> {
    return Promise.reject(new LoggingUIPromptError("confirm", opts.message));
  }

  // ── Disposal ──────────────────────────────────────────────────────

  [Symbol.asyncDispose](): Promise<void> {
    // No teardown needed — LoggingUI holds no resources beyond the
    // injected stream references.
    return Promise.resolve();
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private writeLine(stream: NodeJS.WritableStream, text: string): void {
    stream.write(`${text}\n`);
  }

  private renderInline(message: string): string {
    return renderInlineMarkdown(message);
  }
}

/**
 * Map a change action ("create" | "delete" | "modify" | other) to a
 * single-character glyph. Plain ASCII so it stays readable on
 * terminals without unicode rendering.
 */
function changedFileGlyph(action: string): string {
  if (action === "create") {
    return "+";
  }
  if (action === "delete") {
    return "−";
  }
  return "~";
}

/**
 * Render a single `FileTreeRow` for the LoggingUI's stdout summary.
 * No colors — same shape as the InkUI / post-dispose tree, but
 * box-drawing characters and glyphs ship as plain text so CI logs
 * stay greppable.
 */
function formatTreeRowPlain(row: {
  prefix: string;
  branch: string;
  kind: "file" | "directory";
  label: string;
  action?: string;
}): string {
  const branchPart = `${row.prefix}${row.branch}`;
  if (row.kind === "directory") {
    return `${branchPart} ${row.label}`;
  }
  return `${branchPart} ${changedFileGlyph(row.action ?? "modify")} ${row.label}`;
}

function stopPrefix(code: SpinnerExitCode): string {
  switch (code) {
    case 0:
      return "ok:";
    case 1:
      return "error:";
    default:
      return "warn:";
  }
}
