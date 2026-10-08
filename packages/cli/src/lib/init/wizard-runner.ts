/**
 * Wizard Runner
 *
 * Main suspend/resume loop that drives the remote Mastra workflow.
 * Each iteration: check status → if suspended, perform tool or
 * interactive prompt → resume with result → repeat.
 *
 * All UI I/O — banners, spinners, logs, prompts, outro — flows through
 * a single `WizardUI` instance constructed by `getUI()`. The runner
 * itself is implementation-agnostic: it works the same against
 * `LoggingUI` (CI / `--yes`) and `InkUI` (interactive terminal).
 */

import { randomBytes } from "node:crypto";

import { MastraClient } from "@mastra/client-js";
import {
  addBreadcrumb,
  captureException,
  getTraceData,
  setTag,
} from "@sentry/node-core/light";
import { formatAuthHeader } from "../auth-header.js";
import { formatBanner } from "../banner.js";
import { CLI_VERSION } from "../constants.js";
import { customFetch } from "../custom-ca.js";
import { detectAgent } from "../detect-agent.js";
import { ApiError, EXIT, WizardError } from "../errors.js";
import {
  renderInlineMarkdown,
  stripColorTags,
} from "../formatters/markdown.js";
import { logger } from "../logger.js";
import {
  abortIfCancelled,
  PROGRESS_ROTATE_INTERVAL_MS,
  STEP_ACTIVE_LABELS,
  STEP_PROGRESS_MESSAGES,
  WizardCancelledError,
} from "./clack-utils.js";
import {
  API_TIMEOUT_MS,
  EXIT_DEPENDENCY_INSTALL_FAILED,
  EXIT_PLATFORM_NOT_DETECTED,
  EXIT_VERIFICATION_FAILED,
  INIT_PROTOCOL_VERSION,
  INIT_REQUEST_CONFLICT_CODE,
  MASTRA_API_URL,
  VERIFY_CHANGES_STEP,
  WORKFLOW_ID,
} from "./constants.js";
import { formatError, formatResult } from "./formatters.js";
import { checkGitStatus } from "./git.js";
import {
  assertHostedInitServiceAcceptsTokenHost,
  WORKFLOW_CREATE_RUN_ENDPOINT,
  WORKFLOW_RESUME_ASYNC_ENDPOINT,
  WORKFLOW_START_ASYNC_ENDPOINT,
  withInitServiceAuthClassification,
} from "./init-service-auth.js";
import { handleInteractive } from "./interactive.js";
import { resolveInitContext } from "./preflight.js";
import { checkReadiness } from "./readiness.js";

import { describeTool, executeTool } from "./tools/registry.js";
import type {
  InteractivePayload,
  ResolvedInitContext,
  SentryProjectIdentity,
  SuspendPayload,
  ToolPayload,
  ToolResult,
  WizardOptions,
  WorkflowRunResult,
} from "./types.js";
import { getUIAsync } from "./ui/factory.js";
import { LoggingUIPromptError } from "./ui/logging-ui.js";
import type { SpinnerHandle, WelcomeOptions, WizardUI } from "./ui/types.js";
import { type VerifyResult, verifySetup } from "./verify-setup.js";
import {
  precomputeDirListing,
  precomputeSentryDetection,
  preReadCommonFiles,
} from "./workflow-inputs.js";

type SpinState = { running: boolean };

const INIT_SERVICE_AUTH_FAILED_LABEL = "Authentication failed";

const APPLY_CODEMODS_STEP = "apply-codemods";

type CompactPhaseHistoryEntry = {
  ok: boolean;
  operation: ToolPayload["operation"];
  _phase: string;
  error?: string;
  data?: { files: Record<string, null> };
};

/**
 * Mutable holder for the Sentry project identity captured mid-run.
 *
 * The `create-sentry-project` / `ensure-sentry-project` tool runs locally and
 * returns the org/project identifiers, but that result only travels back to the
 * server in `resumeData`. This ref lets the runner retain it so the final
 * completion screen can build the Issues link without a server round-trip.
 */
type SentryProjectRef = { current?: SentryProjectIdentity };

type StepContext = {
  payload: InteractivePayload | ToolPayload;
  stepId: string;
  spin: SpinnerHandle;
  spinState: SpinState;
  context: ResolvedInitContext;
  ui: WizardUI;
  sentryProject: SentryProjectRef;
};

/** Tool operations that create/resolve the Sentry project and return its identity. */
const SENTRY_PROJECT_OPERATIONS = new Set<ToolPayload["operation"]>([
  "create-sentry-project",
  "ensure-sentry-project",
]);

/** Narrow a tool result's `data` to a Sentry project identity, if it has one. */
function extractSentryProjectIdentity(
  data: unknown,
): SentryProjectIdentity | undefined {
  if (!data || typeof data !== "object") {
    return;
  }
  const d = data as Record<string, unknown>;
  if (
    typeof d.orgSlug === "string" &&
    typeof d.projectSlug === "string" &&
    typeof d.projectId === "string"
  ) {
    return {
      orgSlug: d.orgSlug,
      projectSlug: d.projectSlug,
      projectId: d.projectId,
      dsn: typeof d.dsn === "string" ? d.dsn : undefined,
      url: typeof d.url === "string" ? d.url : undefined,
    };
  }
  return;
}

function nextPhase(
  stepPhases: Map<string, number>,
  stepId: string,
  names: string[],
): string {
  const phase = (stepPhases.get(stepId) ?? 0) + 1;
  stepPhases.set(stepId, phase);
  return names[Math.min(phase - 1, names.length - 1)] ?? "done";
}

function hasFileMap(
  value: unknown,
): value is { files: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "files" in value &&
    typeof value.files === "object" &&
    value.files !== null &&
    !Array.isArray(value.files)
  );
}

function hasHttpStatus(value: unknown): value is { status: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "status" in value &&
    typeof value.status === "number"
  );
}

/** Copy the validated v1 request identity onto a resume payload. */
function initProtocolEnvelope(payload: SuspendPayload): {
  protocolVersion: 1;
  requestId: string;
} {
  return {
    protocolVersion: INIT_PROTOCOL_VERSION,
    requestId: payload.requestId,
  };
}

function hasActiveStepsPath(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  activeStepsPath: Record<string, unknown>;
} {
  return (
    typeof value.activeStepsPath === "object" &&
    value.activeStepsPath !== null &&
    !Array.isArray(value.activeStepsPath)
  );
}

function filePathMarkersForHistory(
  data: unknown,
): Record<string, null> | undefined {
  if (!hasFileMap(data)) {
    return;
  }

  return Object.fromEntries(
    Object.keys(data.files).map((path) => [path, null]),
  );
}

/**
 * Keep `_prevPhases` useful to apply-codemods without resending prior file contents.
 * The server only needs prior errors and read file paths for retry/replan decisions.
 */
function summarizeToolPhaseForHistory(
  payload: ToolPayload,
  phase: string,
  result: ToolResult,
): CompactPhaseHistoryEntry {
  const summary: CompactPhaseHistoryEntry = {
    ok: result.ok,
    operation: payload.operation,
    _phase: phase,
  };
  if (result.error) {
    summary.error = result.error;
  }
  const files = filePathMarkersForHistory(result.data);
  if (files) {
    summary.data = { files };
  }
  return summary;
}

/**
 * Truncate a spinner message to fit within the terminal width.
 * Leaves room for the spinner character and padding.
 */
function truncateForTerminal(message: string): string {
  return message.split("\n").map(truncateLineForTerminal).join("\n");
}

function truncateLineForTerminal(line: string): string {
  const maxWidth = (process.stdout.columns || 80) - 4;
  const visibleLine = stripColorTags(line).replace(/`/g, "");
  if (visibleLine.length <= maxWidth) {
    return line;
  }
  let truncated = line.slice(0, maxWidth - 1);
  const backtickCount = truncated.split("`").length - 1;
  if (backtickCount % 2 !== 0) {
    const lastBacktick = truncated.lastIndexOf("`");
    truncated =
      truncated.slice(0, lastBacktick) + truncated.slice(lastBacktick + 1);
  }
  return `${truncated}…`;
}

type ReadFilesDisplay = {
  paths: string[];
  phase: "reading" | "analyzing";
};

function formatReadFilesSummary(progress: ReadFilesDisplay): string {
  const { paths, phase } = progress;
  const count = paths.length;
  if (count === 0) {
    return phase === "analyzing" ? "Analyzing files..." : "Reading files...";
  }
  if (phase === "analyzing") {
    return count === 1 ? "Analyzing 1 file..." : `Analyzing ${count} files...`;
  }
  return count === 1 ? "Reading 1 file..." : `Reading ${count} files...`;
}

/**
 * Build a follow-up spinner message after a tool succeeds and the CLI is
 * waiting for the server to continue processing the returned data.
 */
function describePostTool(payload: ToolPayload): string | undefined {
  switch (payload.operation) {
    case "read-files":
      return formatReadFilesSummary({
        paths: payload.params.paths,
        phase: "analyzing",
      });
    case "list-dir":
      return "Analyzing directory structure...";
    case "file-exists-batch":
      return "Analyzing project files...";
    default:
      return;
  }
}

type ProgressRotationHandle = {
  /** Stop the rotation timer permanently. */
  stop: () => void;
  /**
   * Pause rotation so recovery paths (e.g. "Reconnecting...") can
   * set the spinner without the next tick overwriting it.
   * Recovery always ends with stop() (via the finally block), so
   * there is no corresponding resume().
   */
  pause: () => void;
};

const NOOP_ROTATION: ProgressRotationHandle = {
  stop: () => {
    // No rotating messages for this step.
  },
  pause: () => {
    // noop
  },
};

/**
 * Start a rotating progress message timer for steps that have long
 * server-side phases without intermediate suspends. Returns a handle
 * to stop or pause the timer.
 *
 * The timer cycles through {@link STEP_PROGRESS_MESSAGES} for the given
 * step, updating the spinner text every {@link PROGRESS_ROTATE_INTERVAL_MS}.
 * After exhausting all messages, it appends elapsed time so the user
 * knows the system is still working.
 *
 * The handle exposes `pause()` so that recovery paths inside
 * `resumeWithRecovery` can suppress rotation while showing
 * "Reconnecting..." without the next tick overwriting it. Recovery
 * always ends with `stop()` (via the `finally` block in the main loop),
 * so there is no corresponding `resume()`.
 */
function startProgressRotation(
  stepId: string,
  spin: SpinnerHandle,
  spinState: SpinState,
): ProgressRotationHandle {
  const messages = STEP_PROGRESS_MESSAGES[stepId];
  if (!messages || messages.length === 0) {
    return NOOP_ROTATION;
  }

  let index = -1;
  let paused = false;
  const startedAt = Date.now();

  const timer = setInterval(() => {
    if (!spinState.running || paused) {
      return;
    }
    index += 1;
    if (index < messages.length) {
      spin.message(messages[index]);
    } else {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const lastMessage = messages.at(-1) ?? messages[0];
      spin.message(`${lastMessage} (${elapsedSec}s)`);
    }
  }, PROGRESS_ROTATE_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(timer);
    },
    pause: () => {
      paused = true;
    },
  };
}

// suspend handling needs to branch across tool and interactive payload kinds
async function handleSuspendedStep(
  ctx: StepContext,
  stepPhases: Map<string, number>,
  stepHistory: Map<string, CompactPhaseHistoryEntry[]>,
): Promise<Record<string, unknown>> {
  const { payload, stepId, spin, spinState, context, ui, sentryProject } = ctx;

  if (payload.type === "tool") {
    const message =
      ("detail" in payload && typeof payload.detail === "string"
        ? payload.detail
        : undefined) ??
      (payload.operation === "read-files"
        ? formatReadFilesSummary({
            paths: payload.params.paths,
            phase: "reading",
          })
        : describeTool(payload));
    spin.message(renderInlineMarkdown(truncateForTerminal(message)));

    // Inline / sidebar file-read status (`InkUI` only — `LoggingUI`
    // leaves these methods undefined). The previous flow showed a
    // half-second tree of files in the spinner before the next tool
    // overwrote it; users couldn't see what context the wizard
    // looked at. We feed the read paths into the status indicator
    // before the tool runs, then mark them analyzed afterwards.
    if (payload.operation === "read-files") {
      ui.recordFilesReading?.(payload.params.paths);
    }

    const toolResult = await executeTool(payload, context);

    // The CLI creates the Sentry project itself — retain the identity it just
    // resolved so the completion screen can build the Issues link locally,
    // without the server having to echo org/project/projectId back.
    if (
      SENTRY_PROJECT_OPERATIONS.has(payload.operation) &&
      toolResult.ok !== false
    ) {
      const identity = extractSentryProjectIdentity(toolResult.data);
      if (identity) {
        sentryProject.current = identity;
      }
    }

    if (toolResult.message) {
      // Tool messages (e.g. "Using existing project ...") describe a
      // completed sub-action that the sidebar Tasks checklist already
      // tracks. Surface it as a transient spinner update instead of
      // stopping the spinner to persist a ✔ line that just duplicates the
      // checklist.
      spin.message(
        renderInlineMarkdown(truncateForTerminal(toolResult.message)),
      );
    } else {
      const followUpMessage =
        toolResult.ok === false ? undefined : describePostTool(payload);
      if (followUpMessage) {
        spin.message(
          renderInlineMarkdown(truncateForTerminal(followUpMessage)),
        );
      }
    }

    if (payload.operation === "read-files" && toolResult.ok !== false) {
      ui.markFilesAnalyzed?.(payload.params.paths);
    }

    const phase = nextPhase(stepPhases, stepId, [
      "read-files",
      "analyze",
      "done",
    ]);
    const history = stepHistory.get(stepId) ?? [];
    const previousPhases = history.slice();
    history.push(summarizeToolPhaseForHistory(payload, phase, toolResult));
    stepHistory.set(stepId, history);

    const resumeData: Record<string, unknown> = {
      ...toolResult,
      _phase: phase,
    };
    if (stepId === APPLY_CODEMODS_STEP) {
      // apply-codemods uses prior failures and read paths to repair failed patches.
      // Other steps do not need phase history, so skip it to avoid payload growth.
      resumeData._prevPhases = previousPhases;
    }
    return resumeData;
  }

  if (payload.type === "interactive") {
    if (context.dryRun && stepId === VERIFY_CHANGES_STEP) {
      return {
        action: "continue",
        _phase: nextPhase(stepPhases, stepId, ["apply"]),
      };
    }

    // Stop the spinner to hand its row over to the interactive prompt, but
    // pass an empty message so no ✔ line is persisted for the step label
    // (e.g. "Selecting features"). The sidebar Tasks checklist already
    // tracks step progress, so a duplicate line in the activity log is noise.
    spin.stop("");
    spinState.running = false;

    const interactiveResult = await handleInteractive(payload, context, ui);

    // Safety net: { cancelled: true } would send malformed resume data to the
    // server and produce a cryptic HTTP 500. All interactive handlers should
    // throw on unresolvable prompts instead of returning this sentinel, but
    // guard here as well so any future regression fails loudly on the CLI side.
    if (interactiveResult.cancelled === true) {
      throw new WizardError(
        "Setup could not complete: interactive step was not resolved.",
        { rendered: false },
      );
    }

    // Feature review is complete, so name the next visible phase instead of
    // briefly falling back to generic processing while the server advances.
    spin.start(
      stepId === "select-features"
        ? STEP_ACTIVE_LABELS["plan-codemods"]
        : "Processing...",
    );
    spinState.running = true;

    return {
      ...interactiveResult,
      _phase: nextPhase(stepPhases, stepId, ["apply"]),
    };
  }

  spin.stop("Error", 1);
  spinState.running = false;
  const message = `Unknown suspend payload type "${(payload as { type: string }).type}"`;
  ui.log.error(message);
  throw new WizardError(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function showCancelledFeedback(ui: WizardUI): void {
  ui.cancel("Setup cancelled.");
  ui.feedback("cancelled");
}

function showFailedFeedback(ui: WizardUI, message = "Setup failed"): void {
  ui.cancel(message);
  ui.feedback("failed");
}

function assertWorkflowResult(raw: unknown): WorkflowRunResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid workflow response: expected object");
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.status !== "string" ||
    !["suspended", "success", "failed"].includes(obj.status)
  ) {
    throw new Error(`Unexpected workflow status: ${String(obj.status)}`);
  }
  if (hasActiveStepsPath(obj)) {
    const activeStepIds = Object.keys(obj.activeStepsPath);
    if (activeStepIds.length > 0) {
      obj.suspended = activeStepIds.map((id) => [id]);
    }
  }
  return obj as WorkflowRunResult;
}

/** Parse suspend payloads and require the complete v1 transport identity. */
function assertSuspendPayload(raw: unknown): SuspendPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid suspend payload: expected object");
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.type !== "string" ||
    !["tool", "interactive"].includes(obj.type)
  ) {
    throw new Error(`Unknown suspend payload type: ${String(obj.type)}`);
  }
  if (
    obj.protocolVersion !== INIT_PROTOCOL_VERSION ||
    typeof obj.requestId !== "string" ||
    obj.requestId.length === 0
  ) {
    throw new Error("Invalid init protocol envelope");
  }
  return obj as SuspendPayload;
}

/** Keep transport identity at the wire boundary, outside local tool and UI contracts. */
function localSuspendPayload(
  payload: SuspendPayload,
): InteractivePayload | ToolPayload {
  const {
    protocolVersion: _protocolVersion,
    requestId: _requestId,
    ...localPayload
  } = payload;
  return localPayload;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function buildWelcomeOptions(): WelcomeOptions {
  return {
    title: "Sentry Init",
    body: [
      "We'll use AI to inspect this project and configure Sentry.",
      "You'll choose the setup before local files change.",
    ],
    punchline: "Continue to let Sentry use AI for setup.",
  };
}

async function confirmExperimental(
  options: WizardOptions,
  ui: WizardUI,
): Promise<boolean> {
  if (options.yes || options.dryRun) {
    return true;
  }
  if (ui.welcome) {
    const choice = await ui.welcome(buildWelcomeOptions());
    return abortIfCancelled(choice) === "continue";
  }
  // The wizard modifies files on disk. We use `select` rather than
  // `confirm` so the cancel path can carry a muted, explicit hint
  // ("exits without changes") — the previous binary yes/no felt
  // ambiguous about what "no" did. The earlier wording used an
  // all-caps "EXPERIMENTAL:" prefix which read like a warning the
  // user had to dismiss; this version frames the question as a
  // sanity check before the wizard does work.
  const choice = await ui.select<"continue" | "exit">({
    message:
      "This is experimental and will modify files in this directory. Continue?",
    options: [
      {
        value: "continue",
        label: "Yes, continue",
        hint: "wizard will detect your stack and apply changes",
      },
      {
        value: "exit",
        label: "No, exit",
        hint: "exits without making any changes",
      },
    ],
    initialValue: "continue",
  });
  const resolved = abortIfCancelled(choice);
  return resolved === "continue";
}

async function preamble(
  options: WizardOptions,
  ui: WizardUI,
): Promise<boolean> {
  if (!(options.yes || options.dryRun || process.stdin.isTTY)) {
    throw new WizardError(
      "Interactive mode requires a terminal. Use --yes for non-interactive mode.",
      { rendered: false },
    );
  }

  // Suppress the ASCII art banner for agent-driven runs — it wastes
  // tokens and adds noise to structured output without value to the
  // agent. For interactive runs, the UI implementation handles
  // rendering: InkUI paints from a pre-loaded gradient, LoggingUI
  // writes plain ANSI to stderr.
  if (!detectAgent()) {
    ui.banner(formatBanner());
  }
  ui.intro("sentry init");

  let confirmed: boolean;
  try {
    confirmed = await confirmExperimental(options, ui);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      setTag("wizard.outcome", "bailed");
      showCancelledFeedback(ui);
      process.exitCode = 0;
      return false;
    }
    if (err instanceof LoggingUIPromptError) {
      throw new WizardError(
        "The interactive UI failed to load. Run with --yes for non-interactive mode.",
        { rendered: false },
      );
    }
    throw err;
  }
  if (!confirmed) {
    setTag("wizard.outcome", "bailed");
    showCancelledFeedback(ui);
    process.exitCode = 0;
    return false;
  }

  if (options.dryRun) {
    ui.log.warn("Dry-run mode: no files will be modified.");
  }

  const gitOk = await checkGitStatus({
    cwd: options.directory,
    yes: options.yes || options.dryRun,
    ui,
  });
  if (!gitOk) {
    setTag("wizard.outcome", "bailed");
    showCancelledFeedback(ui);
    process.exitCode = 0;
    return false;
  }

  return true;
}

const RUN_STATE_RECOVERY_INITIAL_BACKOFF_MS = [0, 250, 750, 1500];
const RUN_STATE_RECOVERY_POLL_MS = 3000;
const RUN_STATE_RECOVERY_MAX_WAIT_MS = 120_000;
const RUN_STATE_RECOVERY_TIMEOUT_MS = 10_000;

type ResumeRetryArgs = {
  run: {
    resumeAsync: (args: Record<string, unknown>) => Promise<unknown>;
    readonly runId: string;
  };
  workflow: {
    runById: (runId: string, opts?: { fields?: string[] }) => Promise<unknown>;
  };
  stepId: string;
  payload: SuspendPayload;
  resumeData: Record<string, unknown>;
  tracingOptions: Record<string, unknown>;
  spin: SpinnerHandle;
  ui: WizardUI;
  progressRotation?: ProgressRotationHandle;
};

/**
 * Detect Mastra's "not suspended" conflict — means the server already
 * processed this step (our previous request succeeded but the response was
 * dropped before we received it). The MastraClientError message embeds the
 * server body, e.g.:
 *   "HTTP error! status: 500 - {"error":"This workflow step 'X' was not suspended..."}"
 * or:
 *   "HTTP error! status: 500 - {"error":"This workflow run was not suspended"}"
 */
function isStepAlreadyAdvancedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("was not suspended");
}

/** Match the API's stable stale-request response, not mutable error prose. */
function isInitProtocolConflictError(err: unknown): boolean {
  if (httpStatus(err) !== 409 || typeof err !== "object" || err === null) {
    return false;
  }
  const body = Reflect.get(err, "body") as unknown;
  return (
    typeof body === "object" &&
    body !== null &&
    Reflect.get(body, "code") === INIT_REQUEST_CONFLICT_CODE
  );
}

function httpStatus(err: unknown): number | undefined {
  return hasHttpStatus(err) ? err.status : undefined;
}

function runStateRecoveryBackoffMs(): number[] {
  const delays = [...RUN_STATE_RECOVERY_INITIAL_BACKOFF_MS];
  let totalWaitMs = delays.reduce((total, delayMs) => total + delayMs, 0);
  while (totalWaitMs < RUN_STATE_RECOVERY_MAX_WAIT_MS) {
    const delayMs = Math.min(
      RUN_STATE_RECOVERY_POLL_MS,
      RUN_STATE_RECOVERY_MAX_WAIT_MS - totalWaitMs,
    );
    delays.push(delayMs);
    totalWaitMs += delayMs;
  }
  return delays;
}

/** A v1 request advances only when the active request ID changed. */
function isRecoverableRunState(
  result: WorkflowRunResult,
  resumedStepId: string,
  resumedPayload: SuspendPayload,
): boolean {
  if (result.status !== "suspended") {
    return true;
  }

  const recovered = extractSuspendPayload(result, resumedStepId);
  if (!recovered) {
    return false;
  }

  return recovered.payload.requestId !== resumedPayload.requestId;
}

/**
 * Recover from stale or ambiguous resume failures by fetching the current run state.
 * If the workflow has already advanced (e.g. plan-codemods is now suspended),
 * the returned WorkflowRunResult lets the main loop continue from the right step.
 */
async function tryRecoverCurrentRunState(
  workflow: ResumeRetryArgs["workflow"],
  runId: string,
  resumedStepId: string,
  resumedPayload: SuspendPayload,
): Promise<WorkflowRunResult | null> {
  const deadlineAt = Date.now() + RUN_STATE_RECOVERY_MAX_WAIT_MS;
  for (const delayMs of runStateRecoveryBackoffMs()) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    if (delayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delayMs, remainingMs)),
      );
    }
    const timeoutMs = Math.min(
      RUN_STATE_RECOVERY_TIMEOUT_MS,
      deadlineAt - Date.now(),
    );
    if (timeoutMs <= 0) {
      return null;
    }
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      const raw = await withTimeout(
        workflow.runById(runId, {
          fields: [
            "status",
            "suspended",
            "steps",
            "activeStepsPath",
            "suspendPayload",
            "result",
            "error",
          ],
        }),
        timeoutMs,
        "Run state recovery",
      );
      const result = assertWorkflowResult(raw);
      if (isRecoverableRunState(result, resumedStepId, resumedPayload)) {
        return result;
      }
    } catch {
      // Mastra/D1 can briefly return a not-yet-readable or intermediate run
      // state while the original resume request is still running. Keep
      // observing run state instead of replaying a non-idempotent resume.
    }
  }
  return null;
}

/**
 * Resume once, then recover by observing durable run state. This never
 * re-executes the local tool when a response was lost or its request is stale.
 */
async function resumeWithRecovery(
  args: ResumeRetryArgs,
): Promise<WorkflowRunResult> {
  const {
    run,
    workflow,
    stepId,
    payload,
    resumeData,
    tracingOptions,
    spin,
    ui,
    progressRotation,
  } = args;
  const wireResumeData = {
    ...resumeData,
    ...initProtocolEnvelope(payload),
  };
  try {
    const raw = await withTimeout(
      withInitServiceAuthClassification(
        () =>
          run.resumeAsync({
            step: stepId,
            resumeData: wireResumeData,
            tracingOptions,
          }),
        WORKFLOW_RESUME_ASYNC_ENDPOINT,
      ),
      API_TIMEOUT_MS,
      "Workflow resume",
    );
    return assertWorkflowResult(raw);
  } catch (err) {
    if (isStepAlreadyAdvancedError(err) || isInitProtocolConflictError(err)) {
      progressRotation?.pause();
      spin.message("Reconnecting...");
      const recovered = await tryRecoverCurrentRunState(
        workflow,
        run.runId,
        stepId,
        payload,
      );
      if (recovered) {
        addBreadcrumb({
          category: "wizard",
          message: `stale-step recovery succeeded for ${stepId}`,
          level: "info",
          data: { stepId, runId: run.runId },
        });
        return recovered;
      }
      captureException(err, {
        level: "warning",
        tags: {
          "wizard.stale_step_recovery": "failed",
          "wizard.resume_step": stepId,
        },
        extra: { runId: run.runId },
      });
      throw err;
    }

    if (httpStatus(err) !== undefined) {
      throw err;
    }

    progressRotation?.pause();
    ui.setOverlay?.({
      kind: "health",
      message: "Connection interrupted, reconnecting...",
      retryCount: 1,
    });
    spin.message("Reconnecting...");
    const recovered = await tryRecoverCurrentRunState(
      workflow,
      run.runId,
      stepId,
      payload,
    );
    ui.clearOverlay?.();
    if (recovered) {
      addBreadcrumb({
        category: "wizard",
        message: `resume state recovery succeeded for ${stepId}`,
        level: "info",
        data: { stepId, runId: run.runId },
      });
      return recovered;
    }
    throw err;
  }
}

/** Run the wizard while negotiating v1 and echoing each suspended request ID. */
// sequential wizard orchestration with error handling branches
export async function runWizard(initialOptions: WizardOptions): Promise<void> {
  // Note: a previous `forwardFreshTtyToStdin()` call lived here as a
  // macOS-only workaround for clack reading from a broken inherited
  // stdin fd (PRs #824/#831/#833/#835). It's gone now because:
  //
  //   1. `LoggingUI` doesn't read from stdin at all (its prompts
  //      throw without `--yes`).
  //   2. `InkUI` opens its own fresh `/dev/tty` ReadStream and
  //      passes it directly to Ink's `stdin` option, sidestepping
  //      both the macOS clack bug and a separate Bun/Ink stdin bug
  //      (oven-sh/bun#6862, vadimdemedes/ink#636) where Bun's
  //      `process.stdin` accepts `setRawMode(true)` but never
  //      delivers `readable` events.
  //
  // The `forwardFreshTtyToStdin` function is preserved in
  // `stdin-reopen.ts` for future callers (and its tests) but no
  // longer wired into the wizard.

  const { directory, yes, dryRun, features, forceLegacyUi } = initialOptions;

  // Tag the whole run's telemetry with dry-run mode. Dry runs plan changes but
  // apply and install nothing, so post-apply verification (both this CLI's
  // `verify-setup` runtime check and the server's `verify-changes` step) sees an
  // unmodified project and reports expected "issues". This tag lets that
  // expected noise be filtered out (`wizard.dry_run:false` isolates real runs).
  setTag("wizard.dry_run", dryRun === true);

  // Construct the UI once for the entire run; tear down on every exit
  // path via `await using`. The factory picks `InkUI` for interactive
  // runs and `LoggingUI` for CI / `--yes` / `--no-tui`.
  const initialWelcome = yes || dryRun ? undefined : buildWelcomeOptions();
  await using ui = await getUIAsync({
    yes,
    forceLegacy: forceLegacyUi,
    ...(initialWelcome ? { initialWelcome } : {}),
  });
  ui.setIntroMode?.(!yes);

  if (!(await preamble(initialOptions, ui))) {
    return;
  }

  await checkReadiness(ui);

  const effectiveOptions = dryRun
    ? { ...initialOptions, yes: true }
    : initialOptions;
  const context = await resolveInitContext(effectiveOptions, ui);
  if (!context) {
    setTag("wizard.outcome", "bailed");
    return;
  }

  const tracingOptions = {
    traceId: randomBytes(16).toString("hex"),
    tags: ["sentry-cli", "init-wizard"],
    metadata: {
      cliVersion: CLI_VERSION,
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      dryRun,
    },
  };

  assertHostedInitServiceAcceptsTokenHost();
  const token = context.authToken;

  // AbortController bound to the MastraClient lifecycle. Aborting on
  // teardown (success OR failure, via `using` below) cancels any in-flight
  // fetches — releasing keep-alive sockets so the event loop drains and
  // `sentry init` returns to the shell promptly. Without this, a stuck or
  // idle socket in Bun's fetch dispatcher can hold the process alive past
  // the wizard's natural exit.
  const abortController = new AbortController();
  using _mastraCleanup = {
    [Symbol.dispose]: (): void => {
      // AbortController.abort() is spec-idempotent, so no guard needed.
      abortController.abort();
    },
  };

  const client = new MastraClient({
    baseUrl: MASTRA_API_URL,
    retries: 0,
    headers: token ? { Authorization: formatAuthHeader(token) } : {},
    abortSignal: abortController.signal,
    fetch: ((url, init) => {
      const traceData = getTraceData();
      // Preserve `init.signal` via the spread — MastraClient may pass its
      // own per-request signal, and the client-level `abortSignal` is
      // forwarded through the same channel.
      return customFetch(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(traceData["sentry-trace"] && {
            "sentry-trace": traceData["sentry-trace"],
          }),
          ...(traceData.baggage && { baggage: traceData.baggage }),
        },
      });
    }) as typeof fetch,
  });
  const workflow = client.getWorkflow(WORKFLOW_ID);

  const spin = ui.spinner();
  const spinState: SpinState = { running: false };

  spin.start("Scanning project...");
  spinState.running = true;

  let run: Awaited<ReturnType<typeof workflow.createRun>>;
  let result: WorkflowRunResult;
  try {
    const [dirListing, existingSentry] = await Promise.all([
      precomputeDirListing(directory),
      precomputeSentryDetection(directory).catch(() => null),
    ]);
    const fileCache = await preReadCommonFiles(directory, dirListing);
    ui.setIntroMode?.(false);
    spin.message("Connecting to wizard...");
    run = await withInitServiceAuthClassification(
      () => workflow.createRun(),
      WORKFLOW_CREATE_RUN_ENDPOINT,
    );
    // Large shared context (dirListing, fileCache, existingSentry)
    // travels via Mastra's workflow `initialState` instead of `inputData`.
    // Keeping it on state means the server stores it exactly once per run
    // rather than duplicating it across every step's output in the D1
    // snapshot — which used to overflow the per-row size limit on big
    // projects and surface as a cascading "workflow run was not suspended"
    // error. See getsentry/cli-init-api#98.
    result = assertWorkflowResult(
      await withTimeout(
        withInitServiceAuthClassification(
          () =>
            run.startAsync({
              inputData: {
                client: {
                  cliVersion: CLI_VERSION,
                  protocolVersion: INIT_PROTOCOL_VERSION,
                },
                directory,
                yes,
                dryRun,
                features,
              },
              initialState: {
                dirListing,
                fileCache,
                existingSentry: existingSentry?.data,
                knownPlatform: context.existingProject?.platform,
              },
              tracingOptions,
            }),
          WORKFLOW_START_ASYNC_ENDPOINT,
        ),
        API_TIMEOUT_MS,
        "Workflow start",
      ),
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      spin.stop(INIT_SERVICE_AUTH_FAILED_LABEL, 1);
      spinState.running = false;
      showFailedFeedback(ui, INIT_SERVICE_AUTH_FAILED_LABEL);
      throw err;
    }
    spin.stop("Connection failed", 1);
    spinState.running = false;
    ui.log.error(errorMessage(err));
    showFailedFeedback(ui);
    throw new WizardError(errorMessage(err));
  }

  const stepPhases = new Map<string, number>();
  const stepHistory = new Map<string, CompactPhaseHistoryEntry[]>();
  // Populated when the create/ensure-sentry-project tool runs; read at the end
  // to build the completion screen's Issues link from local data.
  const sentryProjectRef: SentryProjectRef = {};

  syncWorkflowStepStatuses(result, ui);

  // Track which step the runner is currently suspended on so the
  // sidebar checklist can flip rows as the workflow advances. A
  // single step can suspend multiple times (read-files → analyze →
  // done); `setStep("...", "in_progress")` is idempotent in the
  // store, and we only fire the `completed` transition when the
  // active step changes.
  let activeStepId: string | undefined;

  try {
    while (result.status === "suspended") {
      const stepPath = result.suspended?.at(0) ?? [];
      const stepId: string = stepPath.at(-1) ?? "unknown";

      const extracted = extractSuspendPayload(result, stepId);
      if (!extracted) {
        spin.stop("Error", 1);
        spinState.running = false;
        if (activeStepId) {
          ui.setStep?.(activeStepId, "failed");
        }
        ui.log.error(`No suspend payload found for step "${stepId}"`);
        throw new WizardError(`No suspend payload found for step "${stepId}"`);
      }

      // Step transition: if the active step just changed, mark the
      // previous one completed before flipping this one to
      // in_progress. The store back-fills any earlier `pending`
      // entries as `skipped` on the in_progress transition.
      if (activeStepId && activeStepId !== extracted.stepId) {
        ui.setStep?.(activeStepId, "completed");
      }
      activeStepId = extracted.stepId;
      ui.setStep?.(extracted.stepId, "in_progress");
      let activeLabel = STEP_ACTIVE_LABELS[extracted.stepId];
      if (
        extracted.stepId === "detect-platform" &&
        context.existingProject?.platform
      ) {
        activeLabel = `Analyzing project (existing Sentry platform: ${context.existingProject.platform})...`;
      }
      if (activeLabel && spinState.running) {
        spin.message(activeLabel);
      }

      const resumeData = await handleSuspendedStep(
        {
          payload: localSuspendPayload(extracted.payload),
          stepId: extracted.stepId,
          spin,
          spinState,
          context,
          ui,
          sentryProject: sentryProjectRef,
        },
        stepPhases,
        stepHistory,
      );

      const progressRotation = startProgressRotation(
        extracted.stepId,
        spin,
        spinState,
      );
      try {
        result = await resumeWithRecovery({
          run,
          workflow,
          stepId: extracted.stepId,
          payload: extracted.payload,
          resumeData,
          tracingOptions,
          spin,
          ui,
          progressRotation,
        });
        syncWorkflowStepStatuses(result, ui);
      } finally {
        progressRotation.stop();
      }
    }
  } catch (err) {
    const isAuthFailure = err instanceof ApiError && err.status === 401;
    const isPermissionFailure =
      err instanceof ApiError && (err.status === 401 || err.status === 403);
    // A running spinner owns a live interval, so stop it before any early
    // return or rethrow to avoid leaving the event loop artificially busy.
    if (spinState.running) {
      let label = "Error";
      let code: 0 | 1 = 1;
      if (err instanceof WizardCancelledError) {
        label = "Cancelled";
        code = 0;
      } else if (isAuthFailure) {
        label = INIT_SERVICE_AUTH_FAILED_LABEL;
      } else if (isPermissionFailure) {
        label = "Sentry API request denied";
      }
      spin.stop(label, code);
      spinState.running = false;
    }
    if (err instanceof WizardCancelledError) {
      // Cancellation is a clean exit, not a failure — leave the
      // active step as `in_progress` rather than flipping it to
      // failed; the post-dispose report shows the cancel message
      // instead.
      setTag("wizard.outcome", "bailed");
      showCancelledFeedback(ui);
      process.exitCode = 0;
      return;
    }
    if (activeStepId) {
      ui.setStep?.(activeStepId, "failed");
    }
    if (isAuthFailure) {
      showFailedFeedback(ui, INIT_SERVICE_AUTH_FAILED_LABEL);
      setTag("wizard.outcome", "errored");
      throw err;
    }
    if (isPermissionFailure) {
      showFailedFeedback(ui, "Sentry API request denied");
      setTag("wizard.outcome", "errored");
      throw err;
    }
    if (err instanceof WizardError) {
      showFailedFeedback(ui);
      setTag("wizard.outcome", "errored");
      throw err;
    }
    ui.log.error(errorMessage(err));
    showFailedFeedback(ui);
    setTag("wizard.outcome", "errored");
    throw new WizardError(errorMessage(err));
  }

  // Workflow exited the suspend loop successfully — mark the last
  // active step (if any) as completed before the final-result handler
  // emits its outcome line. Status === "success" implies the final
  // step finished; failure paths run through the catch above and
  // already marked the step `failed`.
  if (activeStepId && result.status === "success") {
    ui.setStep?.(activeStepId, "completed");
  }

  await handleFinalResult(
    result,
    spin,
    spinState,
    ui,
    directory,
    sentryProjectRef.current,
  );
  setTag("wizard.outcome", "completed");
  if (result.result?.platform) {
    setTag("wizard.platform", String(result.result.platform));
  }
  if (result.result?.features) {
    const resultFeatures = result.result.features;
    setTag(
      "wizard.features",
      Array.isArray(resultFeatures)
        ? resultFeatures.join(",")
        : String(resultFeatures),
    );
  }
}

/**
 * Reconcile checklist rows with Mastra's persisted step results.
 *
 * A step can finish entirely inside a start/resume request without ever
 * suspending for CLI work. Those steps still appear in `result.steps`, so
 * their server-reported status is more complete than the suspend transitions
 * observed by the client.
 */
function syncWorkflowStepStatuses(
  result: WorkflowRunResult,
  ui: WizardUI,
): void {
  for (const [stepId, step] of Object.entries(result.steps ?? {})) {
    if (step.status === "success") {
      ui.setStep?.(stepId, "completed");
    } else if (step.status === "failed") {
      ui.setStep?.(stepId, "failed");
    }
  }
}

type WorkflowFailure = {
  message: string;
  resultForDisplay: WorkflowRunResult;
  workflowCode: number | undefined;
};

function getWorkflowFailure(
  result: WorkflowRunResult,
): WorkflowFailure | undefined {
  const workflowCode = result.result?.exitCode;
  if (result.status === "success" && workflowCode === 0) {
    return;
  }

  const missingExitCodeMessage =
    result.status === "success" && workflowCode === undefined
      ? "Workflow reported success without an explicit exit code"
      : undefined;
  const message =
    missingExitCodeMessage ??
    result.error ??
    result.result?.message ??
    "Workflow returned an error";

  return {
    message,
    resultForDisplay: missingExitCodeMessage
      ? { ...result, error: message }
      : result,
    workflowCode,
  };
}

// oxlint-disable-next-line max-params -- cwd and sentryProject are optional trailing extensions
export async function handleFinalResult(
  result: WorkflowRunResult,
  spin: SpinnerHandle,
  spinState: SpinState,
  ui: WizardUI,
  cwd?: string,
  sentryProject?: SentryProjectIdentity,
): Promise<void> {
  const failure = getWorkflowFailure(result);

  if (failure) {
    if (spinState.running) {
      spin.stop("Failed", 1);
      spinState.running = false;
    }
    formatError(failure.resultForDisplay, ui);

    // Map workflow-internal exit codes to semantic EXIT.* constants
    const exitCode = mapWorkflowExitCode(failure.workflowCode);
    setTag("wizard.outcome", "errored");
    if (failure.workflowCode !== undefined) {
      setTag("wizard.exit_code", failure.workflowCode);
    }
    throw new WizardError(failure.message, { exitCode });
  }

  // Run verification before printing the final summary so the user
  // sees the result inline with the rest of the output.
  let verify: VerifyResult | undefined;
  if (cwd) {
    if (spinState.running) {
      spin.message("Verifying setup...");
    }
    try {
      verify = await verifySetup(result, ui, cwd);
    } catch (error) {
      logger.debug("Verification threw unexpectedly", error);
    }
  }

  if (spinState.running) {
    spin.stop("Done");
    spinState.running = false;
  }
  formatResult(result, ui, verify, sentryProject);
}

/**
 * Map a workflow-internal exit code to a semantic EXIT.* constant.
 *
 * The remote workflow uses its own code scheme (20=platform not detected,
 * 30=deps failed, 40/41=codemod failed, 50=verification). We translate
 * these into the CLI's decade-based exit codes so scripts can distinguish
 * wizard failure categories.
 */
function mapWorkflowExitCode(workflowCode: number | undefined): number {
  switch (workflowCode) {
    case EXIT_PLATFORM_NOT_DETECTED:
      return EXIT.CONFIG;
    case EXIT_DEPENDENCY_INSTALL_FAILED:
      return EXIT.WIZARD_DEPS;
    // 40/41 are server-side only (codemod plan/apply) — not in constants.ts
    case 40:
    case 41:
      return EXIT.WIZARD_CODEMOD;
    case EXIT_VERIFICATION_FAILED:
      return EXIT.WIZARD_VERIFY;
    default:
      return EXIT.WIZARD;
  }
}

function activeStepIdsFor(result: WorkflowRunResult, stepId: string): string[] {
  const activeStepsPathIds = Object.keys(result.activeStepsPath ?? {});
  if (activeStepsPathIds.length > 0) {
    return activeStepsPathIds;
  }

  const ids = new Set<string>();
  for (const path of result.suspended ?? []) {
    const id = path.at(-1);
    if (id) {
      ids.add(id);
    }
  }
  if (ids.size === 0 && stepId !== "unknown") {
    ids.add(stepId);
  }
  return [...ids];
}

function extractSuspendPayloadFromStep(
  result: WorkflowRunResult,
  stepId: string,
): { payload: SuspendPayload; stepId: string } | undefined {
  const stepPayload = result.steps?.[stepId]?.suspendPayload;
  if (!stepPayload) {
    return;
  }
  return { payload: assertSuspendPayload(stepPayload), stepId };
}

function extractSuspendPayload(
  result: WorkflowRunResult,
  stepId: string,
): { payload: SuspendPayload; stepId: string } | undefined {
  const activeStepIds = activeStepIdsFor(result, stepId);
  if (activeStepIds.length > 0) {
    for (const activeStepId of activeStepIds) {
      const extracted = extractSuspendPayloadFromStep(result, activeStepId);
      if (extracted) {
        return extracted;
      }
    }
    if (result.suspendPayload) {
      return {
        payload: assertSuspendPayload(result.suspendPayload),
        stepId: activeStepIds[0] ?? stepId,
      };
    }
    return;
  }

  if (result.suspendPayload) {
    return { payload: assertSuspendPayload(result.suspendPayload), stepId };
  }

  const payloadEntries = Object.entries(result.steps ?? {}).filter(
    ([, entry]) => entry.suspendPayload,
  );
  if (payloadEntries.length !== 1) {
    return;
  }
  const [payloadStepId, step] = payloadEntries[0] as [
    string,
    { suspendPayload: unknown },
  ];
  return {
    payload: assertSuspendPayload(step.suspendPayload),
    stepId: payloadStepId,
  };
}
