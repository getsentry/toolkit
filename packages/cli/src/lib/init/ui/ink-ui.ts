/**
 * InkUI — Ink-based `WizardUI` implementation.
 *
 * The class is a thin bridge between the imperative `WizardUI`
 * surface (which the wizard runner calls into) and a React tree
 * mounted via Ink's `render()`. State lives in a `WizardStore`
 * (see `wizard-store.ts`) that React subscribes to via
 * `useSyncExternalStore`. Each method on this class translates a
 * single imperative call into one or more store mutations; React
 * re-renders.
 *
 * Why Ink rather than OpenTUI?
 *
 *   - **No native binary cost.** The OpenTUI implementation added
 *     ~10.7 MB to the compiled Bun binary (the `libopentui.so`
 *     plus the ~12k-line generated FFI bindings). Ink is pure JS,
 *     so it bundles cleanly with no platform-specific peer
 *     packages.
 *   - **Inline rendering.** Ink writes incrementally to stdout, so
 *     log lines naturally end up in the user's scrollback. OpenTUI
 *     needed an alternate-screen buffer + a post-dispose stderr
 *     replay to leave any trace of the run behind.
 *
 * **Stdin workaround for Bun.** Ink listens for `readable` events
 * on its `stdin` option (default `process.stdin`) and calls
 * `stdin.read()` to consume bytes. Bun's compiled binaries have a
 * long-standing bug — `process.stdin` accepts `setRawMode(true)` but
 * never delivers `readable` events for terminal input
 * (oven-sh/bun#6862, vadimdemedes/ink#636, both still open). The
 * symptom: the wizard renders fine but arrow keys, Enter, and
 * Ctrl+C all do nothing.
 *
 * Workaround: open a fresh `/dev/tty` `ReadStream` ourselves and
 * pass it to Ink as the `stdin` option. The fresh stream's
 * `readable` events fire correctly because the file-descriptor
 * inheritance bug only affects fd 0, not fds we open inside the
 * process. We close the stream on dispose to release the libuv
 * handle.
 *
 * **Lazy import.** The Ink app sidecar (`ink-app.js`) is a
 * self-contained ESM bundle with all deps (ink, react, yoga-layout)
 * inlined. It's loaded lazily by `createInkUI()` via dynamic
 * `import()` so the `LoggingUI` path stays cheap to instantiate
 * when interactive UI is not needed. On the Bun binary the sidecar
 * is embedded in `/$bunfs/`; on the npm/Node distribution it ships
 * as `dist/ink-app.js` alongside the CJS bundle.
 */

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { createRequire } from "node:module";
import { ReadStream } from "node:tty";

const _require = createRequire(import.meta.url);

import { addBreadcrumb, setTag } from "@sentry/node-core/light";
import { FULL_BANNER_LINES } from "../../banner.js";
import { openBrowser } from "../../browser.js";
import { CLI_VERSION } from "../../constants.js";
import { stripAnsi } from "../../formatters/plain-detect.js";
import {
  createWizardPromptTelemetry,
  type WizardPromptKind,
} from "../../telemetry.js";
import { formatFeedbackHint, type InitFeedbackOutcome } from "../feedback.js";
import {
  formatFailureReport,
  formatSuccessExitLine,
  formatSuccessReport,
} from "./ink-report.js";
import { LEARN_SEQUENCE } from "./learn-content.js";
import { SENTRY_TIPS } from "./sentry-tips.js";
import {
  CANCELLED,
  type Cancelled,
  type ConfirmOptions,
  type MultiSelectOptions,
  type SelectOptions,
  type SpinnerExitCode,
  type SpinnerHandle,
  type WelcomeOptions,
  type WizardLog,
  type WizardSummary,
  type WizardUI,
} from "./types.js";
import { type ActivePrompt, WizardStore } from "./wizard-store.js";

type CreateInkUIOptions = {
  initialWelcome?: WelcomeOptions;
};

type PendingWelcome = {
  promise: Promise<"continue" | Cancelled>;
  tracedPromise?: Promise<"continue" | Cancelled>;
  resolve: (value: "continue" | Cancelled) => void;
  settled: boolean;
};

type InkPromptOptions = {
  initialWelcome?: PendingWelcome;
  telemetry?: ReturnType<typeof createWizardPromptTelemetry>;
};

/** Tip rotation cadence in the sidebar — slow enough to read each tip. */
const TIP_ROTATE_INTERVAL_MS = 15_000;

function sanitizeWelcomeOptions(opts: WelcomeOptions): WelcomeOptions {
  return {
    title: stripAnsi(opts.title),
    body: opts.body.map(stripAnsi),
    punchline: stripAnsi(opts.punchline),
  };
}

function createPendingWelcome(): PendingWelcome {
  let resolve!: (value: "continue" | Cancelled) => void;
  const pending: PendingWelcome = {
    promise: new Promise<"continue" | Cancelled>((r) => {
      resolve = r;
    }),
    resolve: (value) => {
      if (pending.settled) {
        return;
      }
      pending.settled = true;
      resolve(value);
    },
    settled: false,
  };
  return pending;
}

/** Handle that keeps the wizard alive on the completion screen until the user
 * dismisses it. `[Symbol.asyncDispose]` awaits `promise`. */
type PendingOutro = {
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
};

function createPendingOutro(): PendingOutro {
  let resolve!: () => void;
  const pending: PendingOutro = {
    promise: new Promise<void>((r) => {
      resolve = r;
    }),
    resolve: () => {
      if (pending.settled) {
        return;
      }
      pending.settled = true;
      resolve();
    },
    settled: false,
  };
  return pending;
}

/** Run one shell command with the real terminal attached, resolving when it
 * exits. Used for post-exit actions (e.g. the interactive agent installer)
 * after the alternate screen has been torn down. Never rejects. */
function runInheritedCommand(command: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, { shell: true, stdio: "inherit" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    } catch {
      resolve();
    }
  });
}

function seedWelcomePrompt(
  store: WizardStore,
  opts: WelcomeOptions,
  pending: PendingWelcome
): void {
  store.setLayout("intro");
  store.setPrompt({
    kind: "welcome",
    options: sanitizeWelcomeOptions(opts),
    resolve: (value) => {
      store.setPrompt(null);
      pending.resolve(value === null ? CANCELLED : value);
    },
  });
}

/**
 * Log severities recognised by InkUI. Mirrors the keys of
 * `ICON_BY_SEVERITY` in `ink-app.tsx`.
 */
type LogSeverity = "info" | "warn" | "error" | "success" | "message";

/**
 * Severity returned for a spinner stop given its exit code.
 *   0 → success, 1 → error, 2 → warn.
 */
function severityForStopCode(code: SpinnerExitCode): LogSeverity {
  if (code === 1) {
    return "error";
  }
  if (code === 2) {
    return "warn";
  }
  return "success";
}

/**
 * Resolve the Ink sidecar path/source for the current runtime context.
 *
 * The sidecar (`ink-app.js`) is a self-contained ESM bundle produced
 * by `text-import-plugin` during the esbuild step. It inlines ink,
 * react, and all local deps so it can run without `node_modules`.
 *
 * Three runtime contexts:
 *
 * 1. **Node SEA binary**: The sidecar is embedded as a SEA asset via
 *    fossilize's `--assets` flag. Extract with `node:sea.getAsset()`,
 *    write to a temp file, and `import()` it.
 *
 * 2. **Node/npm bundle** (`npx sentry`): The sidecar ships as
 *    `dist/ink-app.js` alongside the CJS bundle. The `text-import-plugin`
 *    emits a virtual module exporting the relative path `"./ink-app.js"`.
 *    Resolved via `import.meta.url` at runtime.
 *
 * 3. **Dev mode** (`pnpm run cli`): The absolute filesystem path to
 *    `ink-app.tsx` is resolved by the text-import-plugin at build time.
 *    In dev (tsx), it points to the source file directly.
 */
// @ts-expect-error: `with { type: "file" }` handled by text-import-plugin at build time
import inkAppPath from "./ink-app.tsx" with { type: "file" };

/**
 * Open a fresh `/dev/tty` `ReadStream` for Ink to consume. Returns
 * `null` when `/dev/tty` isn't available (non-TTY environment, or
 * platforms that don't expose it — Windows). The caller falls back
 * to `process.stdin` in that case, which works on Node but is
 * broken in Bun-compiled binaries (see module docstring).
 */
function openFreshTtyForInk(): ReadStream | null {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const fd = openSync("/dev/tty", "r");
    return new ReadStream(fd);
  } catch {
    return null;
  }
}

/**
 * Async factory for `InkUI`. Imports `ink`, `react`, and the local
 * `App` component lazily, mounts the React tree, and returns the
 * bridge instance. Throws if Ink can't be loaded (e.g. missing peer
 * deps).
 */
export async function createInkUI(
  opts: CreateInkUIOptions = {}
): Promise<InkUI> {
  // Import the Ink App sidecar. Three runtime contexts:
  //
  // 1. Node SEA binary: the sidecar is embedded as a SEA asset.
  //    Extract it via node:sea.getAsset(), write to a temp file,
  //    and import() it.
  //
  // 2. Node/npm (npx sentry@latest): inkAppPath is a relative path
  //    like "./ink-app.js" (emitted by text-import-plugin as a
  //    string literal). Resolve it to an absolute file:// URL using
  //    import.meta.url so Node's dynamic import() can load the
  //    self-contained ESM sidecar from the dist/ directory.
  //
  // 3. Dev mode (pnpm run cli): inkAppPath is the absolute
  //    filesystem path to ink-app.tsx.
  let importPath: string;
  let seaTmpDir: string | undefined;

  // Check if running inside a Node SEA binary
  let isSea = false;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // biome-ignore lint/suspicious/noExplicitAny: node:sea types not yet in @types/node
    const sea = _require("node:sea") as any;
    isSea = sea.isSea?.() === true;
  } catch {
    // node:sea not available (older Node or non-SEA context)
  }

  if (isSea) {
    // Extract the embedded sidecar to a temp file and import it.
    // The asset key matches what fossilize registered via --assets.
    // biome-ignore lint/suspicious/noExplicitAny: node:sea types not yet in @types/node
    const sea = _require("node:sea") as any;
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(join(tmpdir(), "sentry-ink-"));
    const tmpFile = join(tmpDir, "ink-app.js");
    writeFileSync(tmpFile, sea.getAsset("dist-build/ink-app.js", "utf-8"));
    // Node's dynamic import() requires file:// URLs for absolute paths on Windows
    const { pathToFileURL } = await import("node:url");
    importPath = pathToFileURL(tmpFile).href;
    seaTmpDir = tmpDir;
  } else if (inkAppPath.startsWith("./")) {
    // Node/npm bundle — resolve relative to the bundle location
    importPath = new URL(inkAppPath, import.meta.url).href;
  } else {
    // Dev mode — absolute filesystem path
    importPath = inkAppPath;
  }
  const app = (await import(importPath)) as typeof import("./ink-app.js");

  // Clean up SEA temp file — module is cached in memory after import()
  if (seaTmpDir) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      const { rmSync } = await import("node:fs");
      rmSync(seaTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  const store = new WizardStore({
    cliVersion: CLI_VERSION,
    // Seed with the full banner; IntroScreen re-fits it to the live terminal
    // width on every render (shrinking or growing) so it never wraps.
    bannerRows: FULL_BANNER_LINES,
  });
  const initialWelcome = opts.initialWelcome
    ? createPendingWelcome()
    : undefined;
  if (opts.initialWelcome && initialWelcome) {
    seedWelcomePrompt(store, opts.initialWelcome, initialWelcome);
  }
  const promptTelemetry = createWizardPromptTelemetry();

  // Open a fresh /dev/tty so Ink's `readable` event listener
  // actually fires — see the module docstring for the Bun bug
  // details. We hold onto the stream so we can close it on dispose
  // (libuv otherwise keeps the handle alive and the process can't
  // exit cleanly).
  const freshStdin = openFreshTtyForInk();

  // Build render options for Ink:
  // - `exitOnCtrlC: false` lets us route Ctrl+C through the prompt
  //   cancellation path instead of yanking the process down.
  // - `patchConsole: false` keeps `console.*` calls flowing to the
  //   real stdout — Sentry SDK breadcrumbs, debug logs, etc. would
  //   otherwise be swallowed by Ink's render loop.
  const renderOptions: {
    exitOnCtrlC: boolean;
    patchConsole: boolean;
    stdin?: ReadStream;
  } = {
    exitOnCtrlC: false,
    patchConsole: false,
  };
  if (freshStdin) {
    renderOptions.stdin = freshStdin;
  }
  // Enter the alternate screen buffer so the wizard occupies the full
  // terminal. Clear and home the cursor before Ink's first frame so
  // startup never shows stale layout from a prior render.
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  try {
    const instance = app.mountApp(store, renderOptions);

    return new InkUI(instance, store, freshStdin, {
      initialWelcome,
      telemetry: promptTelemetry,
    });
  } catch (error) {
    // Restore the terminal if Ink rendering or UI init fails,
    // otherwise the user is stuck in the alternate screen buffer.
    process.stdout.write("\x1b[?1049l");
    throw error;
  }
}

/**
 * Subset of the Ink `Instance` type we actually use.
 *
 * Defined structurally rather than imported from `ink` so the
 * dynamic-import boundary in `createInkUI` doesn't leak Ink types
 * into the rest of the bridge module. `rerender` takes
 * `react.ReactNode` upstream; we widen it to a generic function
 * type and only ever call `unmount`/`waitUntilExit`/`clear` from
 * the bridge anyway.
 */
type InkInstance = {
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import boundary
  rerender: (node: any) => void;
  /**
   * Clears Ink's last rendered output from the terminal. We call
   * this on dispose so the final post-dispose chalk summary is
   * the only thing left on screen — without it the bordered
   * wizard box stays above the summary, which looked redundant.
   */
  clear: () => void;
};

// ──────────────────────────── Implementation ──────────────────────────

/**
 * Bridge between the imperative `WizardUI` surface and the Ink
 * `App` component. Mutations land in the `WizardStore`; React
 * re-renders.
 */
export class InkUI implements WizardUI {
  private readonly instance: InkInstance;
  private readonly store: WizardStore;
  /**
   * Fresh `/dev/tty` stream Ink reads from. We own this — closing
   * it on dispose lets the libuv handle drain so `process.exit` (or
   * a natural exit) actually fires. `null` when `/dev/tty` couldn't
   * be opened (Windows, sandboxed environments) — Ink falls back to
   * `process.stdin` in that case.
   */
  private readonly freshStdin: ReadStream | null;
  private readonly promptTelemetry: ReturnType<
    typeof createWizardPromptTelemetry
  >;
  private tipTimer: ReturnType<typeof setInterval> | undefined;
  private learnTimer: ReturnType<typeof setInterval> | undefined;

  private tipIndex = 0;
  private activePromptCancel: (() => void) | undefined;
  /** A resolved prompt that may remain visible until its successor is ready. */
  private completedPrompt: ActivePrompt | undefined;
  private cancelHandler: (() => void) | undefined;
  /**
   * Guard so `tearDown()` runs at most once even when called from
   * multiple paths (Ctrl+C in a spinner, then SIGINT, then
   * `[Symbol.asyncDispose]` on the wizard-runner exit). Calling
   * `unmount()` on an already-unmounted Ink instance throws on some
   * Ink versions; running raw-mode restoration on a destroyed stream
   * also throws. The flag short-circuits before either can happen.
   */
  private torndown = false;
  /**
   * Guard so `requestCancel()` runs its no-active-prompt branch at
   * most once. With this flag set, a subsequent Ctrl+C / SIGINT
   * becomes a no-op rather than re-entering teardown — the user is
   * already on the way out.
   */
  private cancelRequested = false;
  /**
   * Final wizard outcome captured by the bridge.
   *
   * Ink renders inline so the log lines naturally land in scrollback
   * — we don't need to replay a transcript on dispose. We do echo
   * a final success/failure summary line after `unmount()` so the
   * user has a clear "what happened" signal at the bottom of the
   * scrollback.
   */
  private outroMessage: string | undefined;
  private failureMessage: string | undefined;
  private feedbackHint: string | undefined;
  private initialWelcome: PendingWelcome | undefined;
  /**
   * Resolved when the user presses any key on the outro screen.
   * `[Symbol.asyncDispose]` awaits this so the `using` block keeps the
   * UI alive until the user has seen and acknowledged the final screen.
   */
  private pendingOutro: PendingOutro | undefined;

  constructor(
    instance: InkInstance,
    store: WizardStore,
    freshStdin: ReadStream | null,
    promptOptions: InkPromptOptions = {}
  ) {
    this.instance = instance;
    this.store = store;
    this.freshStdin = freshStdin;
    this.initialWelcome = promptOptions.initialWelcome;
    this.promptTelemetry =
      promptOptions.telemetry ?? createWizardPromptTelemetry();
    if (this.initialWelcome && !this.initialWelcome.tracedPromise) {
      const initialWelcome = this.initialWelcome;
      initialWelcome.tracedPromise = this.promptTelemetry.tracePrompt(
        "welcome",
        () => initialWelcome.promise
      );
    }
    if (this.initialWelcome && !this.initialWelcome.settled) {
      const initialWelcome = this.initialWelcome;
      this.activePromptCancel = () => {
        this.store.setPrompt(null);
        this.activePromptCancel = undefined;
        initialWelcome.resolve(CANCELLED);
      };
    }
    this.installCancelHandler();
    // Hand the App a reference to `requestCancel` via the store so
    // the top-level `useInput` Ctrl+C catcher in `ink-app.tsx` can
    // route through the same teardown path as SIGINT and prompt
    // cancellation. Without this the App would have to call
    // `process.exit(130)` directly — bypassing termios restoration
    // and leaking the `/dev/tty` handle.
    this.store.setRequestCancel(() => this.requestCancel());
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  banner(_art: string): void {
    // No-op — the App paints the banner inside its header from the
    // gradient rows pre-loaded into the store. The runner-supplied
    // ANSI string is discarded.
  }

  intro(_title: string): void {
    // No-op. The outer box already has a title-bar feel via the
    // banner; an extra "▸ sentry init" line felt redundant.
  }

  outro(message: string): void {
    const clean = stripAnsi(message);
    this.outroMessage = clean;
    // Keep the interactive completion screen mounted until the user dismisses
    // it (see `[Symbol.asyncDispose]`), pausing the sidebar tip rotation so the
    // final screen is stable.
    this.pauseSidebarTimers();
    this.pendingOutro ??= createPendingOutro();
    // Bind the screen's side effects here (main bundle) so the Ink sidecar
    // never imports Node built-ins (browser launch).
    this.store.setOutro({
      kind: "success",
      dismiss: () => this.dismissOutro(),
      actions: {
        openUrl: (url) => {
          // Best-effort; openBrowser never throws, catch keeps it non-blocking.
          // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
          openBrowser(url).catch(() => {
            // ignore
          });
        },
        track: (event) => {
          // Land completion-screen interactions on the run's `cli.command`
          // transaction so we can see, per run, whether the user opened Sentry
          // and/or chose to install the agent plugin. Tags are sticky: once a
          // user has clicked "install", un-toggling leaves the click recorded.
          switch (event) {
            case "open-sentry":
              setTag("wizard.completion.opened_sentry", "true");
              break;
            case "agent-plugin-queued":
              setTag("wizard.completion.agent_plugin_clicked", "true");
              break;
            case "agent-plugin-unqueued":
              break;
            default:
              break;
          }
          addBreadcrumb({
            category: "wizard.completion",
            message: event,
            level: "info",
          });
        },
      },
    });
  }

  cancel(message: string): void {
    const clean = stripAnsi(message);
    this.appendLog("error", clean);
    this.failureMessage = clean;
  }

  feedback(outcome: InitFeedbackOutcome): void {
    this.feedbackHint = formatFeedbackHint(outcome);
  }

  summary(summary: WizardSummary): void {
    this.store.setSummary(summary);
  }

  recordFilesReading(paths: string[]): void {
    this.store.recordFilesReading(paths);
  }

  markFilesAnalyzed(paths: string[]): void {
    this.store.markFilesAnalyzed(paths);
  }

  setStep(
    stepId: string,
    status: "in_progress" | "completed" | "failed" | "skipped"
  ): void {
    this.promptTelemetry.setActiveStep(stepId, status === "in_progress");
    this.store.setStepStatus(stepId, status);
  }

  setOverlay(overlay: {
    kind: string;
    message: string;
    retryCount: number;
  }): void {
    this.store.setOverlay({
      kind: "health",
      message: overlay.message,
      retryCount: overlay.retryCount,
    });
  }

  clearOverlay(): void {
    this.store.clearOverlay();
  }

  setIntroMode(enabled: boolean): void {
    if (enabled) {
      this.store.setLayout("intro");
      this.pauseSidebarTimers();
      return;
    }
    this.store.setLayout("workflow");
    this.startSidebarTimers();
  }

  // ── Logging ───────────────────────────────────────────────────────

  log: WizardLog = {
    info: (message) => this.appendLog("info", message),
    warn: (message) => this.appendLog("warn", message),
    error: (message) => this.appendLog("error", message),
    success: (message) => this.appendLog("success", message),
    message: (message) => this.appendLog("message", message),
  };

  // ── Spinner ───────────────────────────────────────────────────────

  spinner(): SpinnerHandle {
    return {
      start: (message?: string) => {
        const clean = stripAnsi(message ?? "");
        if (
          this.completedPrompt &&
          this.store.getSnapshot().prompt === this.completedPrompt
        ) {
          this.store.replacePromptWithSpinner(clean);
          this.completedPrompt = undefined;
        } else {
          this.store.startSpinner(clean);
        }
        if (clean) {
          this.store.appendStatus(clean);
        }
      },
      message: (message?: string) => {
        if (message !== undefined) {
          const clean = stripAnsi(message);
          this.store.setSpinnerMessage(clean);
          if (clean) {
            this.store.appendStatus(clean);
          }
        }
      },
      stop: (message?: string, code: SpinnerExitCode = 0) => {
        const finalMessage =
          message !== undefined
            ? stripAnsi(message)
            : this.store.getSnapshot().spinner.message;
        this.store.stopSpinner();
        if (finalMessage) {
          this.appendLog(severityForStopCode(code), finalMessage);
        }
      },
    };
  }

  // ── Prompts ───────────────────────────────────────────────────────

  /** Measures only the interval in which the prompt can accept user input. */
  private waitForPrompt<T>(
    kind: WizardPromptKind,
    mount: (resolve: (value: T) => void) => void
  ): Promise<T> {
    return this.promptTelemetry.tracePrompt(kind, () => new Promise<T>(mount));
  }

  /**
   * Defers cleanup so the resumed promise chain can replace the completed prompt.
   * The identity check prevents the old cleanup from removing its successor.
   */
  private completePrompt<T>(
    prompt: ActivePrompt,
    value: T,
    resolve: (resolvedValue: T) => void
  ): void {
    this.activePromptCancel = undefined;
    this.completedPrompt = prompt;
    resolve(value);
    setImmediate(() => {
      if (this.store.getSnapshot().prompt === prompt) {
        this.store.setPrompt(null);
      }
      if (this.completedPrompt === prompt) {
        this.completedPrompt = undefined;
      }
    });
  }

  select<T extends string>(opts: SelectOptions<T>): Promise<T | Cancelled> {
    return this.waitForPrompt<T | Cancelled>("select", (resolve) => {
      const initialIndex =
        opts.initialValue !== undefined
          ? Math.max(
              0,
              opts.options.findIndex(
                (option) => option.value === opts.initialValue
              )
            )
          : 0;
      let settled = false;
      this.activePromptCancel = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.store.setPrompt(null);
        this.activePromptCancel = undefined;
        resolve(CANCELLED);
      };
      const prompt: Extract<ActivePrompt, { kind: "select" }> = {
        kind: "select",
        message: stripAnsi(opts.message),
        ...(opts.details
          ? {
              details: opts.details.map((detail) => ({
                ...detail,
                text: stripAnsi(detail.text),
              })),
            }
          : {}),
        ...(opts.footer
          ? {
              footer: {
                ...opts.footer,
                text: stripAnsi(opts.footer.text),
              },
            }
          : {}),
        options: opts.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.hint ? { hint: option.hint } : {}),
        })),
        initialIndex,
        resolve: (value) => {
          if (settled) {
            return;
          }
          settled = true;
          this.completePrompt(
            prompt,
            value === null ? CANCELLED : (value as T),
            resolve
          );
        },
      };
      this.store.setPrompt(prompt);
    });
  }

  multiselect<T extends string>(
    opts: MultiSelectOptions<T>
  ): Promise<T[] | Cancelled> {
    return this.waitForPrompt<T[] | Cancelled>("multiselect", (resolve) => {
      let settled = false;
      this.activePromptCancel = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.store.setPrompt(null);
        this.activePromptCancel = undefined;
        resolve(CANCELLED);
      };
      const prompt: Extract<ActivePrompt, { kind: "multiselect" }> = {
        kind: "multiselect",
        message: stripAnsi(opts.message),
        ...(opts.details
          ? {
              details: opts.details.map((detail) => ({
                ...detail,
                text: stripAnsi(detail.text),
              })),
            }
          : {}),
        options: opts.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.hint ? { hint: option.hint } : {}),
          ...(option.description ? { description: option.description } : {}),
          ...(option.locked ? { locked: true } : {}),
        })),
        initialSelected: opts.initialValues ?? [],
        required: opts.required ?? false,
        resolve: (values) => {
          if (settled) {
            return;
          }
          settled = true;
          this.completePrompt(
            prompt,
            values === null ? CANCELLED : (values as T[]),
            resolve
          );
        },
      };
      this.store.setPrompt(prompt);
    });
  }

  confirm(opts: ConfirmOptions): Promise<boolean | Cancelled> {
    return this.waitForPrompt<boolean | Cancelled>("confirm", (resolve) => {
      this.activePromptCancel = () => {
        this.store.setPrompt(null);
        this.activePromptCancel = undefined;
        resolve(CANCELLED);
      };
      this.store.setPrompt({
        kind: "confirm",
        message: stripAnsi(opts.message),
        initialValue: opts.initialValue ?? true,
        resolve: (value) => {
          this.store.setPrompt(null);
          this.activePromptCancel = undefined;
          if (value === null) {
            resolve(CANCELLED);
          } else {
            resolve(value);
          }
        },
      });
    });
  }

  welcome(opts: WelcomeOptions): Promise<"continue" | Cancelled> {
    this.store.setLayout("intro");
    this.pauseSidebarTimers();
    if (this.initialWelcome) {
      if (!this.initialWelcome.settled) {
        seedWelcomePrompt(this.store, opts, this.initialWelcome);
      }
      const initialWelcome = this.initialWelcome;
      const promptPromise =
        initialWelcome.tracedPromise ??
        this.promptTelemetry.tracePrompt(
          "welcome",
          () => initialWelcome.promise
        );
      return promptPromise.finally(() => {
        this.activePromptCancel = undefined;
        this.initialWelcome = undefined;
      });
    }
    return this.waitForPrompt<"continue" | Cancelled>("welcome", (resolve) => {
      this.activePromptCancel = () => {
        this.store.setPrompt(null);
        this.activePromptCancel = undefined;
        resolve(CANCELLED);
      };
      this.store.setPrompt({
        kind: "welcome",
        options: sanitizeWelcomeOptions(opts),
        resolve: (value) => {
          this.store.setPrompt(null);
          this.activePromptCancel = undefined;
          if (value === null) {
            resolve(CANCELLED);
          } else {
            resolve(value);
          }
        },
      });
    });
  }

  // ── Disposal ──────────────────────────────────────────────────────

  async [Symbol.asyncDispose](): Promise<void> {
    // Keep the completion screen alive until the user acknowledges it, then
    // tear down the alternate screen and run any commands they queued (e.g.
    // the agent-plugin installer) in their real terminal.
    const pendingOutro = this.pendingOutro;
    if (pendingOutro && !pendingOutro.settled && !this.torndown) {
      await pendingOutro.promise;
    }
    this.tearDown();
    await this.runPostExitActions();
  }

  /** Resolve the completion-screen handoff so async disposal can proceed. */
  private dismissOutro(): void {
    this.pendingOutro?.resolve();
  }

  /**
   * Run commands the completion screen queued, now that the alternate screen is
   * gone and the real terminal is restored. Interactive installers (e.g.
   * `npx @sentry/ai install`) need the real TTY, which the alt-screen denied.
   */
  private async runPostExitActions(): Promise<void> {
    const actions = this.store.getSnapshot().postExitActions;
    if (actions.length > 0) {
      // The agent-plugin installer is the only thing the completion screen
      // queues, so a non-empty list here means the user finished with it queued
      // and we're about to actually run it — the strongest "installed" signal.
      setTag("wizard.completion.agent_plugin_installed", "true");
    }
    for (const command of actions) {
      process.stdout.write(`\n$ ${command}\n`);
      await runInheritedCommand(command);
    }
  }

  /**
   * Idempotent teardown. Safe to call from `[Symbol.asyncDispose]`,
   * from `requestCancel()`, or from a SIGINT handler racing both. The
   * `torndown` guard short-circuits second (and later) entries so we
   * never call `unmount()` on an already-unmounted Ink instance or
   * `setRawMode(false)` on an already-destroyed stream — both throw
   * on some platforms.
   *
   * Order matters:
   *   1. Stop the tip-rotation interval (libuv timer ref).
   *   2. Detach SIGINT listener (we don't want a second Ctrl+C
   *      re-entering this path while we're in the middle of it).
   *   3. `instance.clear()` — rewinds Ink's render region so the
   *      post-dispose chalk summary lands in place of the live
   *      wizard chrome rather than below it.
   *   4. `instance.unmount()` — releases React reconciler resources.
   *   5. Restore termios on the fresh `/dev/tty` stream, then
   *      `pause()` + `destroy()` so libuv can drain the handle and
   *      the process can exit naturally.
   *   6. Emit the post-dispose summary to stdout (success outro or
   *      failure cancel line, matching the live screen's palette).
   *
   * Every step is wrapped in try/catch — disposal must never throw.
   */
  private tearDown(): void {
    if (this.torndown) {
      return;
    }
    this.torndown = true;
    if (this.tipTimer) {
      clearInterval(this.tipTimer);
      this.tipTimer = undefined;
    }
    this.stopLearnSequence();
    if (this.cancelHandler) {
      process.removeListener("SIGINT", this.cancelHandler);
      this.cancelHandler = undefined;
    }
    // Detach the cancel callback from the store so a stale Ctrl+C
    // routed through the App after teardown can't re-enter.
    this.store.setRequestCancel(undefined);
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      this.instance.clear();
    } catch {
      // best-effort
    }
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      this.instance.unmount();
    } catch {
      // best-effort
    }
    // Leave the alternate screen buffer so the user's original
    // scrollback is restored.
    //
    // When the user queued an interactive post-exit action (the agent-plugin
    // installer), also clear the restored screen and home the cursor. Exiting
    // the alt buffer returns the cursor to the row where `sentry init` was
    // invoked — usually low on the screen — so without this the exit summary
    // and the installer's own full-screen UI would render from mid-screen with
    // a blank gap above. Clearing gives the handoff the same clean top-of-screen
    // start as wizard startup (line ~362). The normal exit (no installer) is
    // left untouched so its compact summary flows into scrollback as before.
    const hasPostExitActions =
      this.store.getSnapshot().postExitActions.length > 0;
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      process.stdout.write(
        hasPostExitActions ? "\x1b[?1049l\x1b[2J\x1b[H" : "\x1b[?1049l"
      );
    } catch {
      // best-effort — stdout may already be destroyed
    }
    if (this.freshStdin) {
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        this.freshStdin.setRawMode(false);
      } catch {
        // stream already torn down
      }
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        this.freshStdin.pause();
        this.freshStdin.destroy();
      } catch {
        // stream already destroyed
      }
    }
    const report = this.buildPostDisposeReport();
    if (report) {
      // Write to stdout (not stderr) so the summary lands in the
      // same stream as the cleared Ink output. Mixing stderr in
      // would risk an extra line break or out-of-order interleave
      // depending on shell pipe handling.
      process.stdout.write(`${report}\n`);
    }
  }

  /**
   * Cooperative cancellation entry point. Called from three places:
   *
   *   1. The App's top-level `useInput` Ctrl+C catcher (when no
   *      prompt is mounted — typically during a spinner / network
   *      call). Routed via `store.requestCancel()`.
   *   2. The SIGINT process listener (covers raw-mode-off windows
   *      where Node delivers SIGINT instead of `\x03`).
   *   3. (Indirectly) prompt cancellation, when an active prompt's
   *      own `useInput` resolves with `null`. That path doesn't go
   *      through `requestCancel` directly because the prompt's
   *      promise resolution drives the wizard runner's
   *      `WizardCancelledError` flow, which then runs
   *      `[Symbol.asyncDispose]` → `tearDown()` naturally.
   *
   * If a prompt IS active, we delegate to its cancel callback and
   * return without exiting — the wizard runner will catch the
   * resulting `WizardCancelledError` and exit cleanly via the
   * `await using` path.
   *
   * If no prompt is active (spinner case), we tear down immediately
   * and `process.exit(130)`. We can't route through the runner
   * because it's blocked on `await executeTool(...)` or
   * `await run.resumeAsync(...)` — there's nothing waiting to throw
   * into. Exit code 130 is the SIGINT convention; the terminal is
   * fully restored before exit so the user's shell prompt comes
   * back cleanly.
   *
   * A second Ctrl+C while teardown is in progress force-exits via
   * `process.exit(130)` so the user is never trapped by a stuck
   * teardown.
   */
  requestCancel(): void {
    // On the completion screen, Ctrl+C is just "I'm done" — acknowledge the
    // handoff and let async disposal exit cleanly (0), not the 130 abort path.
    if (this.pendingOutro && !this.pendingOutro.settled) {
      this.dismissOutro();
      return;
    }
    const promptCancel = this.activePromptCancel;
    if (promptCancel) {
      // Prompt path — let the runner unwind via WizardCancelledError.
      // Don't tear down here; the `await using` in the runner will
      // call us back through `[Symbol.asyncDispose]`.
      promptCancel();
      return;
    }
    if (this.cancelRequested) {
      // Safety valve: teardown already started but hasn't finished
      // (or something is stuck). Force-exit so the user isn't trapped.
      setTag("wizard.outcome", "abandoned");
      process.exit(130);
    }
    this.cancelRequested = true;
    this.failureMessage = "Setup cancelled.";
    this.feedback("cancelled");
    this.tearDown();
    // Mark as abandoned before exit so the Sentry span carries the
    // outcome even though beforeExit never fires for explicit process.exit().
    setTag("wizard.outcome", "abandoned");
    // Match the SIGINT convention so shells (and CI) see a
    // distinguishable exit. The runner's `await using` won't get a
    // chance to run after this, but tearDown above already did all
    // the cleanup that path would have performed.
    // Defer exit by one tick so the event loop can flush the
    // stdout writes from tearDown (alternate-screen escape +
    // cancellation report) before the process terminates.
    setImmediate(() => process.exit(130));
  }

  /**
   * Build a compact final summary echoed to stdout after Ink
   * unmounts. Ink's inline rendering means the run's log lines are
   * already in the user's scrollback; this report just emphasises
   * the outcome so it's the last thing on screen.
   *
   * Three shapes:
   *   - Success: outro line + summary fields + changed files.
   *   - Failure: cancel/error line on its own.
   *   - Empty:   no useful state captured (early abort, etc.) —
   *              return `undefined` and the caller skips the
   *              stderr write.
   *
   * Failure wins over success if both are set.
   */
  private buildPostDisposeReport(): string | undefined {
    if (this.failureMessage) {
      return formatFailureReport(
        this.failureMessage,
        this.store.getSnapshot().logs,
        this.feedbackHint
      );
    }
    if (!this.outroMessage) {
      return;
    }
    const summary = this.store.getSnapshot().summary ?? undefined;
    // The interactive completion screen already showed the full summary; on
    // exit leave only a compact confirmation rather than re-dumping everything.
    if (summary?.completion) {
      return formatSuccessExitLine(summary);
    }
    return formatSuccessReport(this.outroMessage, summary, this.feedbackHint);
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private appendLog(severity: LogSeverity, message: string): void {
    this.store.appendLog(severity, stripAnsi(message));
  }

  private startTipRotation(): void {
    if (this.tipTimer) {
      return;
    }
    this.tipTimer = setInterval(() => {
      this.tipIndex = (this.tipIndex + 1) % SENTRY_TIPS.length;
      this.store.setTipIndex(this.tipIndex);
    }, TIP_ROTATE_INTERVAL_MS);
  }

  private startLearnSequence(): void {
    if (this.learnTimer) {
      return;
    }
    const store = this.store;
    this.learnTimer = setInterval(() => {
      if (this.torndown) {
        this.stopLearnSequence();
        return;
      }
      const { learnState } = store.getSnapshot();
      if (learnState.complete) {
        this.stopLearnSequence();
        if (!this.torndown) {
          this.startTipRotation();
        }
        return;
      }
      const next = learnState.blockIndex + 1;
      if (next >= LEARN_SEQUENCE.length) {
        store.setLearnComplete();
        this.stopLearnSequence();
        if (!this.torndown) {
          this.startTipRotation();
        }
      } else {
        store.advanceLearnBlock();
      }
    }, TIP_ROTATE_INTERVAL_MS);
  }

  private stopLearnSequence(): void {
    if (this.learnTimer) {
      clearInterval(this.learnTimer);
      this.learnTimer = undefined;
    }
  }

  private startSidebarTimers(): void {
    if (this.torndown) {
      return;
    }
    if (this.store.getSnapshot().learnState.complete) {
      this.startTipRotation();
      return;
    }
    this.startLearnSequence();
  }

  private pauseSidebarTimers(): void {
    if (this.tipTimer) {
      clearInterval(this.tipTimer);
      this.tipTimer = undefined;
    }
    this.stopLearnSequence();
  }

  /**
   * Fallback SIGINT handler for the (rare) windows where raw mode
   * is OFF and Node's terminal layer DOES deliver SIGINT for
   * Ctrl+C. The primary Ctrl+C handling lives inside Ink's
   * `useInput` (see `ink-app.tsx`'s top-level App component): in
   * raw mode, Node sends `\x03` as a byte instead of SIGINT.
   *
   * This handler covers the brief window between InkUI
   * construction and the first `useInput` listener being mounted,
   * plus any time raw mode flickers off (Ink toggles it in a
   * useEffect when the listener count drops to zero).
   *
   * Both this handler and the App's `useInput` Ctrl+C path funnel
   * into `requestCancel()` so the cancellation flow has a single
   * implementation. Uses `process.on` so the handler survives a
   * prompt-delegation Ctrl+C (where `requestCancel` returns early
   * without setting `cancelRequested`). If teardown is already in
   * progress, `requestCancel` force-exits — protects against a
   * stuck teardown holding the user hostage.
   */
  private installCancelHandler(): void {
    const handler = () => {
      this.requestCancel();
    };
    this.cancelHandler = handler;
    process.on("SIGINT", handler);
  }
}
