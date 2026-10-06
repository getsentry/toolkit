import { MastraClient } from "@mastra/client-js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as Sentry from "@sentry/node-core/light";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type mock,
  test,
  vi,
} from "vitest";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as banner from "../../../src/lib/banner.js";
import { clearAuth, setAuthToken } from "../../../src/lib/db/auth.js";
import { ENV_VAR_AGENTS } from "../../../src/lib/detect-agent.js";
import { setEnv } from "../../../src/lib/env.js";
import { classifySilenced } from "../../../src/lib/error-reporting.js";
import {
  ApiError,
  EXIT,
  HostScopeError,
  WizardError,
} from "../../../src/lib/errors.js";
import {
  CHECKLIST_VISIBLE_STEPS,
  WizardCancelledError,
} from "../../../src/lib/init/clack-utils.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as fmt from "../../../src/lib/init/formatters.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as git from "../../../src/lib/init/git.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as inter from "../../../src/lib/init/interactive.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as preflight from "../../../src/lib/init/preflight.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as readiness from "../../../src/lib/init/readiness.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as registry from "../../../src/lib/init/tools/registry.js";
import type {
  ResolvedInitContext,
  SuspendPayload,
  ToolPayload,
  WizardOptions,
  WorkflowRunResult,
} from "../../../src/lib/init/types.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as uiFactory from "../../../src/lib/init/ui/factory.js";
import {
  CANCELLED,
  type SpinnerHandle,
  type WizardUI,
} from "../../../src/lib/init/ui/types.js";
import { runWizard } from "../../../src/lib/init/wizard-runner.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as workflowInputs from "../../../src/lib/init/workflow-inputs.js";
import { createMockUI, type MockCall } from "./ui/mock-ui.js";

const noop = () => {
  /* suppress output */
};

/**
 * Per-test reference to the spinner mock. The wizard-runner calls
 * `ui.spinner()` exactly once and reuses the handle for the entire run,
 * so we expose a singleton with mock fns the test cases can assert on.
 */
const spinnerMock: SpinnerHandle & {
  start: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  message: ReturnType<typeof mock>;
} = {
  start: vi.fn(),
  stop: vi.fn(),
  message: vi.fn(),
};

let mockUICalls: MockCall[];

function makeOptions(overrides?: Partial<WizardOptions>): WizardOptions {
  return {
    directory: "/tmp/test",
    yes: true,
    dryRun: false,
    ...overrides,
  };
}

function makeContext(
  overrides?: Partial<ResolvedInitContext>
): ResolvedInitContext {
  return {
    directory: "/tmp/test",
    yes: true,
    dryRun: false,
    org: "acme",
    team: "platform",
    authToken: "test-token",
    ...overrides,
  };
}

let mockStartResult: WorkflowRunResult;
let mockResumeResults: WorkflowRunResult[];
let resumeCallCount = 0;
let sharedResumeAsyncMock: ReturnType<typeof mock>;
let startAsyncMock: ReturnType<typeof mock>;
let mockRunByIdResult: WorkflowRunResult | Error;
let runByIdMock: ReturnType<typeof mock>;

let getUISpy: ReturnType<typeof spyOn>;
let formatBannerSpy: ReturnType<typeof spyOn>;
let formatResultSpy: ReturnType<typeof spyOn>;
let formatErrorSpy: ReturnType<typeof spyOn>;
let checkGitStatusSpy: ReturnType<typeof spyOn>;
let handleInteractiveSpy: ReturnType<typeof spyOn>;
let resolveInitContextSpy: ReturnType<typeof spyOn>;
let describeToolSpy: ReturnType<typeof spyOn>;
let executeToolSpy: ReturnType<typeof spyOn>;
let precomputeDirListingSpy: ReturnType<typeof spyOn>;
let preReadCommonFilesSpy: ReturnType<typeof spyOn>;
let precomputeSentryDetectionSpy: ReturnType<typeof spyOn>;
let getWorkflowSpy: ReturnType<typeof spyOn>;
let stderrSpy: ReturnType<typeof spyOn>;
/**
 * ClientOptions captured from each MastraClient instance constructed by
 * runWizard. Used by the MastraClient lifecycle suite to assert that the
 * `abortSignal` passed at construction time is aborted on teardown.
 */
let capturedClientOptions: { abortSignal?: AbortSignal; retries?: number }[] =
  [];

let savedPlainOutput: string | undefined;
let testRequestSequence = 0;
let testEnvelopeByPayload = new WeakMap<
  object,
  { protocolVersion: 1; requestId: string }
>();

/** Model the current server: every valid suspend payload carries a v1 ID. */
function withV1SuspendEnvelope(raw: unknown): unknown {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("type" in raw) ||
    !["tool", "interactive"].includes(String(raw.type)) ||
    "protocolVersion" in raw ||
    "requestId" in raw
  ) {
    return raw;
  }

  let envelope = testEnvelopeByPayload.get(raw);
  if (!envelope) {
    testRequestSequence += 1;
    envelope = {
      protocolVersion: 1,
      requestId: `00000000-0000-4000-8000-${String(testRequestSequence).padStart(12, "0")}`,
    };
    testEnvelopeByPayload.set(raw, envelope);
  }
  return { ...raw, ...envelope };
}

function withV1SuspendEnvelopes(result: WorkflowRunResult): WorkflowRunResult {
  const steps = result.steps
    ? Object.fromEntries(
        Object.entries(result.steps).map(([stepId, step]) => [
          stepId,
          step.suspendPayload === undefined
            ? step
            : {
                ...step,
                suspendPayload: withV1SuspendEnvelope(step.suspendPayload),
              },
        ])
      )
    : undefined;
  return {
    ...result,
    ...(steps ? { steps } : {}),
    ...(result.suspendPayload === undefined
      ? {}
      : { suspendPayload: withV1SuspendEnvelope(result.suspendPayload) }),
  };
}

function forceStdinTty<T>(action: () => Promise<T>): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    process.stdin,
    "isTTY"
  );
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
    writable: true,
  });
  return action().finally(() => {
    if (originalDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", originalDescriptor);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
}

function useMockUI(ui: WizardUI, calls: MockCall[]): void {
  mockUICalls = calls;
  getUISpy.mockResolvedValue({
    ...ui,
    spinner: () => spinnerMock,
  });
}

beforeEach(() => {
  // Force rich output so clack-plain.ts delegates to real clack (spied below)
  savedPlainOutput = process.env.SENTRY_PLAIN_OUTPUT;
  process.env.SENTRY_PLAIN_OUTPUT = "0";

  mockStartResult = {
    status: "success",
    result: { exitCode: 0, platform: "React" },
  };
  mockResumeResults = [];
  resumeCallCount = 0;
  mockRunByIdResult = new Error("runById not configured");
  testRequestSequence = 0;
  testEnvelopeByPayload = new WeakMap();
  process.exitCode = 0;

  spinnerMock.start.mockClear();
  spinnerMock.stop.mockClear();
  spinnerMock.message.mockClear();

  // The wizard runner constructs a UI via `getUI()`. Replace it with a
  // MockUI whose spinner() returns the shared `spinnerMock` so tests can
  // assert on lifecycle calls.
  const { ui, calls, respond } = createMockUI();
  mockUICalls = calls;
  // Pre-load a confirm response so the experimental confirm prompt
  // resolves to "true" by default — the legacy default before MockUI.
  // Tests that exercise `--yes` skip this prompt entirely; the response
  // sits unused on the queue and is harmless.
  respond.confirm(true);
  const wrapped: WizardUI = {
    ...ui,
    spinner: () => spinnerMock,
  };
  getUISpy = vi.spyOn(uiFactory, "getUIAsync").mockResolvedValue(wrapped);

  vi.spyOn(readiness, "checkReadiness").mockResolvedValue(undefined);
  formatBannerSpy = vi.spyOn(banner, "formatBanner").mockReturnValue("BANNER");
  formatResultSpy = vi.spyOn(fmt, "formatResult").mockImplementation(noop);
  formatErrorSpy = vi.spyOn(fmt, "formatError").mockImplementation(noop);
  checkGitStatusSpy = vi.spyOn(git, "checkGitStatus").mockResolvedValue(true);
  handleInteractiveSpy = vi
    .spyOn(inter, "handleInteractive")
    .mockResolvedValue({
      action: "continue",
    });
  resolveInitContextSpy = vi
    .spyOn(preflight, "resolveInitContext")
    .mockResolvedValue(makeContext());
  describeToolSpy = vi
    .spyOn(registry, "describeTool")
    .mockReturnValue("Running tool...");
  executeToolSpy = vi.spyOn(registry, "executeTool").mockResolvedValue({
    ok: true,
    data: { results: [] },
  });
  precomputeDirListingSpy = vi
    .spyOn(workflowInputs, "precomputeDirListing")
    .mockResolvedValue([]);
  preReadCommonFilesSpy = vi
    .spyOn(workflowInputs, "preReadCommonFiles")
    .mockResolvedValue({});
  precomputeSentryDetectionSpy = vi
    .spyOn(workflowInputs, "precomputeSentryDetection")
    .mockResolvedValue({
      ok: true,
      data: { status: "none", signals: [] },
    });
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true as any);

  startAsyncMock = vi.fn(() =>
    Promise.resolve(withV1SuspendEnvelopes(mockStartResult))
  );
  runByIdMock = vi.fn(() =>
    mockRunByIdResult instanceof Error
      ? Promise.reject(mockRunByIdResult)
      : Promise.resolve(withV1SuspendEnvelopes(mockRunByIdResult))
  );
  sharedResumeAsyncMock = vi.fn(() => {
    const result = mockResumeResults[resumeCallCount] ?? {
      status: "success",
      result: { exitCode: 0 },
    };
    resumeCallCount += 1;
    return Promise.resolve(withV1SuspendEnvelopes(result));
  });
  const run = {
    runId: "test-run-id",
    startAsync: startAsyncMock,
    resumeAsync: sharedResumeAsyncMock,
  };
  const workflow = {
    createRun: vi.fn(() => Promise.resolve(run)),
    runById: runByIdMock,
  };
  capturedClientOptions = [];
  getWorkflowSpy = vi
    .spyOn(MastraClient.prototype, "getWorkflow")
    .mockImplementation(function (this: MastraClient) {
      // `this` is the MastraClient instance. `BaseResource.options` holds the
      // full ClientOptions passed to the constructor — including abortSignal.
      capturedClientOptions.push(
        (
          this as unknown as {
            options: { abortSignal?: AbortSignal; retries?: number };
          }
        ).options
      );
      return workflow as any;
    });
});

afterEach(() => {
  vi.useRealTimers();

  getUISpy.mockRestore();
  formatBannerSpy.mockRestore();
  formatResultSpy.mockRestore();
  formatErrorSpy.mockRestore();
  checkGitStatusSpy.mockRestore();
  handleInteractiveSpy.mockRestore();
  resolveInitContextSpy.mockRestore();
  describeToolSpy.mockRestore();
  executeToolSpy.mockRestore();
  precomputeDirListingSpy.mockRestore();
  preReadCommonFilesSpy.mockRestore();
  precomputeSentryDetectionSpy.mockRestore();
  getWorkflowSpy.mockRestore();
  stderrSpy.mockRestore();

  process.exitCode = 0;

  if (savedPlainOutput === undefined) {
    delete process.env.SENTRY_PLAIN_OUTPUT;
  } else {
    process.env.SENTRY_PLAIN_OUTPUT = savedPlainOutput;
  }

  // Restore the env sandbox in case any test used setEnv without try/finally.
  setEnv(process.env);
});

function lastCancelMessage(): string | undefined {
  for (let i = mockUICalls.length - 1; i >= 0; i--) {
    const call = mockUICalls[i];
    if (call?.kind === "cancel") {
      return call.message;
    }
  }
  return;
}

function lastFeedbackOutcome(): string | undefined {
  for (let i = mockUICalls.length - 1; i >= 0; i--) {
    const call = mockUICalls[i];
    if (call?.kind === "feedback") {
      return call.outcome;
    }
  }
  return;
}

function lastWarn(): string | undefined {
  for (let i = mockUICalls.length - 1; i >= 0; i--) {
    const call = mockUICalls[i];
    if (call?.kind === "log.warn") {
      return call.message;
    }
  }
  return;
}

function lastError(): string | undefined {
  for (let i = mockUICalls.length - 1; i >= 0; i--) {
    const call = mockUICalls[i];
    if (call?.kind === "log.error") {
      return call.message;
    }
  }
  return;
}

function initService401Error(): Error {
  return new Error(
    'HTTP error! status: 401 - {"error":"Unauthorized: invalid token"}'
  );
}

async function useSaaSOAuthAuth(authToken = "oauth-token"): Promise<void> {
  await clearAuth();
  const env = { ...process.env };
  delete env.SENTRY_AUTH_TOKEN;
  delete env.SENTRY_TOKEN;
  delete env.SENTRY_FORCE_ENV_TOKEN;
  setEnv(env);
  setAuthToken(authToken, 3600, "refresh-token", {
    host: "https://sentry.io",
  });
  resolveInitContextSpy.mockResolvedValue(makeContext({ authToken }));
}

function initServiceApiErrorShape(endpoint: string) {
  return {
    name: "ApiError",
    status: 401,
    endpoint,
  };
}

function hasExpectedInitServiceAuthPolicy(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 401 &&
    classifySilenced(err) === "api_user_error"
  );
}

describe("runWizard", () => {
  test("rejects a malformed bearer before constructing the service client", async () => {
    resolveInitContextSpy.mockResolvedValue(
      makeContext({ authToken: "synthetic-prefix\nsynthetic-secret-tail" })
    );

    const error = await runWizard(makeOptions()).catch(
      (caught: unknown) => caught
    );
    expect(error).toMatchObject({
      reason: "invalid",
      exitCode: EXIT.AUTH_INVALID,
    });
    expect(String(error)).not.toContain("synthetic-secret-tail");
    expect(capturedClientOptions).toEqual([]);
    expect(getWorkflowSpy).not.toHaveBeenCalled();
  });

  test("formats successful results", async () => {
    await runWizard(makeOptions());

    expect(formatResultSpy).toHaveBeenCalled();
    expect(formatErrorSpy).not.toHaveBeenCalled();
    expect(spinnerMock.stop).toHaveBeenCalledWith("Done");
  });

  test("throws when stdin is not a TTY without --yes", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY"
    );
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
      writable: true,
    });

    try {
      await expect(runWizard(makeOptions({ yes: false }))).rejects.toThrow(
        WizardError
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", originalDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  test("passes dry-run as non-interactive into preflight", async () => {
    await runWizard(makeOptions({ dryRun: true, yes: false }));

    expect(resolveInitContextSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, yes: true }),
      expect.anything()
    );
    expect(lastWarn()).toContain("Dry-run");
  });

  test("uses rich welcome screen when available", async () => {
    const { ui, calls, respond } = createMockUI({ welcome: true });
    respond.welcome("continue");
    useMockUI(ui, calls);

    await forceStdinTty(() =>
      runWizard(
        makeOptions({
          yes: false,
          features: ["errorMonitoring", "performanceMonitoring"],
          org: "bete-dev",
          project: "nextjs",
        })
      )
    );

    const welcome = calls.find((call) => call.kind === "welcome");
    expect(welcome).toBeDefined();
    if (welcome?.kind !== "welcome") {
      throw new Error("expected welcome call");
    }
    expect(welcome.options.title).toBe("Sentry Init");
    expect(welcome.options.body).toContain(
      "We'll use AI to inspect this project and configure Sentry."
    );
    expect(welcome.options.punchline).toContain("use AI for setup");
    expect(getUISpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        initialWelcome: expect.objectContaining({
          title: "Sentry Init",
        }),
      })
    );
    expect(
      calls.some((call) => call.kind === "select" || call.kind === "confirm")
    ).toBe(false);
    const introOn = calls.findIndex(
      (call) => call.kind === "setIntroMode" && call.enabled
    );
    const introOff = calls.findIndex(
      (call) => call.kind === "setIntroMode" && !call.enabled
    );
    expect(introOn).toBeGreaterThanOrEqual(0);
    expect(introOff).toBeGreaterThanOrEqual(0);
    expect(spinnerMock.message.mock.calls).toContainEqual([
      "Connecting to wizard...",
    ]);
    expect(formatResultSpy).toHaveBeenCalled();
  });

  test("does not log a second AI disclaimer after welcome", async () => {
    const { ui, calls, respond } = createMockUI({ welcome: true });
    respond.welcome("continue");
    useMockUI(ui, calls);

    await forceStdinTty(() =>
      runWizard(
        makeOptions({
          yes: false,
          features: ["errorMonitoring"],
          org: "bete-dev",
          project: "nextjs",
        })
      )
    );

    const infoMessages = calls
      .filter((call) => call.kind === "log.info")
      .map((call) => call.message);
    expect(
      infoMessages.some((message) => message.includes("This wizard uses AI"))
    ).toBe(false);
    expect(
      infoMessages.some((message) => message.includes("For manual setup"))
    ).toBe(false);
  });

  test("cancels cleanly from rich welcome screen", async () => {
    const { ui, calls, respond } = createMockUI({ welcome: true });
    respond.welcome(CANCELLED);
    useMockUI(ui, calls);
    const captureSpy = vi.spyOn(Sentry, "captureException");

    try {
      await forceStdinTty(() => runWizard(makeOptions({ yes: false })));

      expect(process.exitCode).toBe(0);
      expect(lastCancelMessage()).toBe("Setup cancelled.");
      expect(lastFeedbackOutcome()).toBe("cancelled");
      expect(getWorkflowSpy).not.toHaveBeenCalled();
      expect(captureSpy).not.toHaveBeenCalled();
    } finally {
      captureSpy.mockRestore();
    }
  });

  test("falls back to generic continue prompt without rich welcome", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.select("continue");
    useMockUI(ui, calls);

    await forceStdinTty(() => runWizard(makeOptions({ yes: false })));

    const select = calls.find((call) => call.kind === "select");
    expect(select).toBeDefined();
    if (select?.kind !== "select") {
      throw new Error("expected select call");
    }
    expect(select.message).toContain("experimental");
    expect(formatResultSpy).toHaveBeenCalled();
  });

  test("aborts cleanly when user declines the experimental prompt", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.select("exit");
    useMockUI(ui, calls);

    await forceStdinTty(() => runWizard(makeOptions({ yes: false })));

    expect(process.exitCode).toBe(0);
    expect(lastCancelMessage()).toBe("Setup cancelled.");
    expect(lastFeedbackOutcome()).toBe("cancelled");
    expect(getWorkflowSpy).not.toHaveBeenCalled();
  });

  test("stops before workflow creation when preflight returns null", async () => {
    resolveInitContextSpy.mockResolvedValue(null);

    await runWizard(makeOptions());

    expect(getWorkflowSpy).not.toHaveBeenCalled();
    expect(formatResultSpy).not.toHaveBeenCalled();
  });

  test("aborts cleanly when git safety check fails", async () => {
    checkGitStatusSpy.mockResolvedValue(false);

    await runWizard(makeOptions());

    expect(lastCancelMessage()).toBe("Setup cancelled.");
    expect(lastFeedbackOutcome()).toBe("cancelled");
    expect(getWorkflowSpy).not.toHaveBeenCalled();
  });

  test("suppresses the ASCII art banner when an agent is detected", async () => {
    setEnv({ ...process.env, CLAUDE_CODE: "1" } as NodeJS.ProcessEnv);
    try {
      await runWizard(makeOptions());
    } finally {
      setEnv(process.env);
    }

    expect(formatBannerSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("BANNER")
    );
  });

  test("prints the ASCII art banner when no agent is detected", async () => {
    // Strip all agent-detection env vars so detectAgent() returns undefined
    // even when running inside an agent environment (e.g. OpenCode in CI).
    const agentKeys = new Set([
      "AI_AGENT",
      "AGENT",
      "CLAUDECODE",
      "CLAUDE_CODE",
      "CURSOR_EXTENSION_HOST_ROLE",
      ...ENV_VAR_AGENTS.keys(),
    ]);
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !agentKeys.has(k))
    );
    setEnv(cleanEnv as NodeJS.ProcessEnv);
    try {
      await runWizard(makeOptions());
    } finally {
      setEnv(process.env);
    }

    expect(formatBannerSpy).toHaveBeenCalled();
    expect(mockUICalls).toContainEqual({ kind: "banner", art: "BANNER" });
  });

  test("dispatches tool payloads through the registry", async () => {
    const payload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["npm install @sentry/node"] },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["apply-codemods"]],
      steps: {
        "apply-codemods": { suspendPayload: payload },
      },
    };
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions());

    expect(describeToolSpy).toHaveBeenCalledWith(payload);
    expect(executeToolSpy).toHaveBeenCalledWith(payload, makeContext());
    expect(spinnerMock.message).toHaveBeenCalledWith("Running tool...");
  });

  test("keeps v1 transport metadata out of local tool payloads", async () => {
    const requestId = "8c7ee6b9-e955-4514-9164-f01844584a28";
    const toolPayload: ToolPayload = {
      type: "tool",
      operation: "apply-patchset",
      cwd: "/tmp/test",
      params: { patches: [] },
    };
    const protocolPayload: SuspendPayload = {
      ...toolPayload,
      protocolVersion: 1,
      requestId,
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["apply-codemods"]],
      steps: {
        "apply-codemods": { suspendPayload: protocolPayload },
      },
    };
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions());

    expect(describeToolSpy).toHaveBeenCalledWith(toolPayload);
    expect(executeToolSpy).toHaveBeenCalledWith(toolPayload, makeContext());
    expect(sharedResumeAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeData: expect.objectContaining({
          protocolVersion: 1,
          requestId,
        }),
      })
    );
  });

  test("keeps v1 transport metadata out of interactive payloads", async () => {
    const requestId = "8c7ee6b9-e955-4514-9164-f01844584a28";
    mockStartResult = {
      status: "suspended",
      suspended: [["pick-feature"]],
      steps: {
        "pick-feature": {
          suspendPayload: {
            type: "interactive",
            kind: "confirm",
            prompt: "Continue?",
            protocolVersion: 1,
            requestId,
          },
        },
      },
    };
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions());

    expect(handleInteractiveSpy).toHaveBeenCalledWith(
      {
        type: "interactive",
        kind: "confirm",
        prompt: "Continue?",
      },
      makeContext(),
      expect.anything()
    );
    expect(sharedResumeAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeData: expect.objectContaining({
          protocolVersion: 1,
          requestId,
        }),
      })
    );
  });

  test("moves feature review directly into code-planning progress", async () => {
    mockStartResult = {
      status: "suspended",
      suspended: [["select-features"]],
      steps: {
        "select-features": {
          suspendPayload: {
            type: "interactive",
            kind: "multi-select",
            prompt: "Select features to enable",
            availableFeatures: ["errorMonitoring", "performanceMonitoring"],
          },
        },
      },
    };
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions());

    expect(spinnerMock.start).toHaveBeenCalledWith("Planning code changes...");
    expect(spinnerMock.start).not.toHaveBeenCalledWith("Processing...");
  });

  test("skips verify-changes interactive prompts during dry-run", async () => {
    const requestId = "3bc6b6f4-e2f5-40e4-9ac5-bbd69bf7af70";
    resolveInitContextSpy.mockResolvedValue(makeContext({ dryRun: true }));
    mockStartResult = {
      status: "suspended",
      suspended: [["verify-changes"]],
      steps: {
        "verify-changes": {
          suspendPayload: {
            type: "interactive",
            kind: "confirm",
            prompt: "Verify changes?",
            protocolVersion: 1,
            requestId,
          },
        },
      },
    };
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions({ dryRun: true }));

    expect(handleInteractiveSpy).not.toHaveBeenCalled();
    expect(sharedResumeAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeData: expect.objectContaining({
          protocolVersion: 1,
          requestId,
        }),
      })
    );
  });

  test("surfaces malformed suspend payload types", async () => {
    mockStartResult = {
      status: "suspended",
      suspended: [["detect-platform"]],
      steps: {
        "detect-platform": {
          suspendPayload: {
            type: "unknown",
            operation: "list-dir",
            cwd: "/tmp/test",
            params: { path: "." },
          },
        },
      },
    };

    await expect(runWizard(makeOptions())).rejects.toThrow(WizardError);
  });

  test.each([
    ["a missing envelope", {}],
    ["an unsupported version", { protocolVersion: 2, requestId: "request" }],
    ["a missing request ID", { protocolVersion: 1 }],
    ["an empty request ID", { protocolVersion: 1, requestId: "" }],
  ])("rejects suspend payloads with %s", async (_label, envelope) => {
    startAsyncMock.mockResolvedValueOnce({
      status: "suspended",
      suspended: [["detect-platform"]],
      steps: {
        "detect-platform": {
          suspendPayload: {
            type: "tool",
            operation: "list-dir",
            cwd: "/tmp/test",
            params: { path: "." },
            ...envelope,
          },
        },
      },
    });

    await expect(runWizard(makeOptions())).rejects.toThrow(
      "Invalid init protocol envelope"
    );
    expect(executeToolSpy).not.toHaveBeenCalled();
  });

  test("fails when a suspended step has no payload", async () => {
    mockStartResult = {
      status: "suspended",
      suspended: [["detect-platform"]],
      steps: {
        "detect-platform": {},
      },
    };

    await expect(runWizard(makeOptions())).rejects.toThrow(WizardError);
  });

  test("tears down forwarding and stops the spinner on tool errors", async () => {
    const payload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["npm install @sentry/node"] },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["apply-codemods"]],
      steps: {
        "apply-codemods": { suspendPayload: payload },
      },
    };
    executeToolSpy.mockRejectedValue(new Error("boom"));

    await expect(runWizard(makeOptions())).rejects.toThrow(WizardError);

    expect(spinnerMock.stop).toHaveBeenCalledWith("Error", 1);
    expect(lastCancelMessage()).toBe("Setup failed");
    expect(lastFeedbackOutcome()).toBe("failed");
  });

  test("preserves 403 errors thrown for command-level scope inspection", async () => {
    const payload: ToolPayload = {
      type: "tool",
      operation: "create-sentry-project",
      cwd: "/tmp/test",
      params: { name: "my-app", platform: "javascript-react" },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["ensure-sentry-project"]],
      steps: {
        "ensure-sentry-project": { suspendPayload: payload },
      },
    };
    const scopeError = new ApiError("Forbidden", 403);
    executeToolSpy.mockRejectedValue(scopeError);

    await expect(runWizard(makeOptions())).rejects.toBe(scopeError);

    expect(spinnerMock.stop).toHaveBeenCalledWith(
      "Sentry API request denied",
      1
    );
    expect(lastCancelMessage()).toBe("Sentry API request denied");
  });

  test("tears down forwarding and stops the spinner on cancellation", async () => {
    const captureSpy = vi.spyOn(Sentry, "captureException");
    const payload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["npm install @sentry/node"] },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["apply-codemods"]],
      steps: {
        "apply-codemods": { suspendPayload: payload },
      },
    };
    executeToolSpy.mockRejectedValue(new WizardCancelledError());

    try {
      await runWizard(makeOptions());

      expect(process.exitCode).toBe(0);
      expect(spinnerMock.stop).toHaveBeenCalledWith("Cancelled", 0);
      expect(lastCancelMessage()).toBe("Setup cancelled.");
      expect(lastFeedbackOutcome()).toBe("cancelled");
      expect(captureSpy).not.toHaveBeenCalled();
    } finally {
      captureSpy.mockRestore();
    }
  });

  test("tears down forwarding when a WizardError is rethrown from a tool", async () => {
    // The reordered catch block stops the spinner BEFORE the WizardError
    // rethrow branch, so any WizardError thrown from handleSuspendedStep
    // (e.g. tool handlers, malformed payloads) must still release the TTY
    // handle via `using` teardown.
    const payload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["npm install @sentry/node"] },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["apply-codemods"]],
      steps: {
        "apply-codemods": { suspendPayload: payload },
      },
    };
    executeToolSpy.mockRejectedValue(
      new WizardError("tool rejected by server")
    );

    await expect(runWizard(makeOptions())).rejects.toThrow(WizardError);

    expect(spinnerMock.stop).toHaveBeenCalledWith("Error", 1);
    expect(lastCancelMessage()).toBe("Setup failed");
    expect(lastFeedbackOutcome()).toBe("failed");
  });

  test("shows count-based messages while reading and analyzing files", async () => {
    mockStartResult = {
      status: "suspended",
      suspended: [["detect-platform"]],
      steps: {
        "detect-platform": {
          suspendPayload: {
            type: "tool",
            operation: "read-files",
            cwd: "/tmp/test",
            params: {
              paths: ["src/settings.py", "src/urls.py"],
              resultVersion: 2,
            },
          },
        },
      },
    };
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions());

    const messages = spinnerMock.message.mock.calls.map(
      (call: string[]) => call[0]
    );
    expect(messages).toContain("Reading 2 files...");
    expect(messages).toContain("Analyzing 2 files...");
  });

  test("passes precomputed dirListing/fileCache/existingSentry via initialState, not inputData", async () => {
    const dirListing = [
      { name: "package.json", path: "package.json", type: "file" as const },
    ];
    const fileCache = { "package.json": '{"name":"app"}' };
    const detectedSentry = { status: "none" as const, signals: [] };

    precomputeDirListingSpy.mockResolvedValue(dirListing);
    preReadCommonFilesSpy.mockResolvedValue(fileCache);
    precomputeSentryDetectionSpy.mockResolvedValue({
      ok: true,
      data: detectedSentry,
    });

    await runWizard(makeOptions());

    expect(startAsyncMock).toHaveBeenCalledTimes(1);
    const call = startAsyncMock.mock.calls[0] as
      | [
          {
            inputData?: Record<string, unknown>;
            initialState?: Record<string, unknown>;
          },
        ]
      | undefined;
    expect(call).toBeDefined();
    const args = call?.[0] ?? {};

    // Large shared context lives on state, not on inputData.
    expect(args.inputData).not.toHaveProperty("dirListing");
    expect(args.inputData).not.toHaveProperty("fileCache");
    expect(args.inputData).not.toHaveProperty("existingSentry");
    expect(args.inputData?.client).toEqual({
      cliVersion: expect.any(String),
      protocolVersion: 1,
    });
    expect(args.initialState?.dirListing).toEqual(dirListing);
    expect(args.initialState?.fileCache).toEqual(fileCache);
    expect(args.initialState?.existingSentry).toEqual(detectedSentry);
  });

  test("renders tool result messages as a transient spinner message, not a persisted line", async () => {
    mockStartResult = {
      status: "suspended",
      suspended: [["ensure-sentry-project"]],
      steps: {
        "ensure-sentry-project": {
          suspendPayload: {
            type: "tool",
            operation: "create-sentry-project",
            cwd: "/tmp/test",
            params: { name: "my-app", platform: "javascript-react" },
          },
        },
      },
    };
    executeToolSpy.mockResolvedValue({
      ok: true,
      message: "Using existing project",
      data: {},
    });
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions());

    // Tool messages update the live spinner instead of persisting a ✔ line —
    // the sidebar Tasks checklist already tracks step completion, so a
    // duplicate line in the activity log is just noise.
    expect(spinnerMock.message).toHaveBeenCalledWith("Using existing project");
    expect(spinnerMock.stop).not.toHaveBeenCalledWith("Using existing project");
  });

  test("captures the created Sentry project identity and forwards it to formatResult", async () => {
    const identity = {
      orgSlug: "acme",
      projectSlug: "my-app",
      projectId: "4507",
      dsn: "https://k@o0.ingest.sentry.io/4507",
      url: "https://acme.sentry.io/settings/projects/my-app/",
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["ensure-sentry-project"]],
      steps: {
        "ensure-sentry-project": {
          suspendPayload: {
            type: "tool",
            operation: "create-sentry-project",
            cwd: "/tmp/test",
            params: { name: "my-app", platform: "javascript-react" },
          },
        },
      },
    };
    executeToolSpy.mockResolvedValue({ ok: true, data: identity });
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions());

    // The identity comes from the local tool result, not the server output —
    // the CLI creates the project itself, so it passes what it already knows
    // as formatResult's 4th arg to build the Issues link without a round-trip.
    expect(formatResultSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      identity
    );
  });

  test("shows --yes hint when LoggingUI prompt fails", async () => {
    const { LoggingUIPromptError } = await import(
      "../../../src/lib/init/ui/logging-ui.js"
    );
    const { ui } = createMockUI();
    const failingUI: WizardUI = {
      ...ui,
      spinner: () => spinnerMock,
      select: () =>
        Promise.reject(
          new LoggingUIPromptError(
            "select",
            "This is experimental and will modify files"
          )
        ),
    };
    getUISpy.mockResolvedValue(failingUI);

    await expect(
      forceStdinTty(() => runWizard(makeOptions({ yes: false })))
    ).rejects.toThrow("Run with --yes for non-interactive mode.");
  });
});

describe("runWizard — MastraClient lifecycle", () => {
  test("aborts the MastraClient signal after a successful run", async () => {
    await runWizard(makeOptions());

    expect(capturedClientOptions).toHaveLength(1);
    expect(capturedClientOptions[0]?.retries).toBe(0);
    const signal = capturedClientOptions[0]?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // Using the non-null assertion safely — we asserted toBeInstanceOf above.
    expect((signal as AbortSignal).aborted).toBe(true);
  });

  test("aborts the MastraClient signal when a tool throws", async () => {
    const payload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["npm install @sentry/node"] },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["apply-codemods"]],
      steps: {
        "apply-codemods": { suspendPayload: payload },
      },
    };
    executeToolSpy.mockRejectedValue(new Error("tool blew up"));

    await expect(runWizard(makeOptions())).rejects.toThrow(WizardError);

    expect(capturedClientOptions).toHaveLength(1);
    const signal = capturedClientOptions[0]?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(true);
  });

  test("aborts the MastraClient signal on cancellation", async () => {
    const payload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["npm install @sentry/node"] },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["apply-codemods"]],
      steps: {
        "apply-codemods": { suspendPayload: payload },
      },
    };
    executeToolSpy.mockRejectedValue(new WizardCancelledError());

    await runWizard(makeOptions());

    expect(capturedClientOptions).toHaveLength(1);
    const signal = capturedClientOptions[0]?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(true);
  });

  test("signal is live (not pre-aborted) while the wizard is running", async () => {
    // `getWorkflow` runs BEFORE `startAsync` (client.getWorkflow is called
    // synchronously right after `new MastraClient(...)`), so the signal
    // observed at that time is the same instance that in-flight fetches
    // would see during the wizard. If the signal were somehow pre-aborted
    // at construction, it would be aborted here too. This proves the
    // `using _mastraCleanup` disposable does NOT fire until teardown.
    let abortedAtConstruction: boolean | undefined;
    getWorkflowSpy.mockImplementation(function (this: MastraClient) {
      const opts = (
        this as unknown as {
          options: { abortSignal?: AbortSignal; retries?: number };
        }
      ).options;
      capturedClientOptions.push(opts);
      abortedAtConstruction = opts.abortSignal?.aborted;
      return {
        createRun: vi.fn(() =>
          Promise.resolve({
            startAsync: startAsyncMock,
            resumeAsync: vi.fn(() =>
              Promise.resolve({ status: "success", result: { exitCode: 0 } })
            ),
          })
        ),
      } as any;
    });

    await runWizard(makeOptions());

    expect(abortedAtConstruction).toBe(false);
    // And teardown aborted it by the time the wizard returned.
    expect(capturedClientOptions[0]?.abortSignal?.aborted).toBe(true);
  });
});

// ─── Additional coverage tests ───────────────────────────────────────────────

describe("runWizard — workflow exit codes", () => {
  test("rejects workflow success without an explicit exit code", async () => {
    mockStartResult = { status: "success", result: { platform: "React" } };

    const error = await runWizard(makeOptions()).catch((caught) => caught);

    expect(error).toBeInstanceOf(WizardError);
    expect((error as WizardError).exitCode).not.toBe(0);
  });

  // handleFinalResult calls mapWorkflowExitCode when the workflow result
  // carries a non-zero exitCode. Each case maps a server-internal code to
  // the CLI's semantic EXIT constant.
  test.each([
    [20, EXIT.CONFIG],
    [30, EXIT.WIZARD_DEPS],
    [40, EXIT.WIZARD_CODEMOD],
    [41, EXIT.WIZARD_CODEMOD],
    [50, EXIT.WIZARD_VERIFY],
    // 999 is an unknown code; also exercises the default branch of mapWorkflowExitCode
    [999, EXIT.WIZARD],
  ])("maps workflow exit code %s to the expected EXIT constant", async (workflowCode, expectedExitCode) => {
    mockStartResult = {
      status: "success",
      result: { exitCode: workflowCode },
    };

    const err = await runWizard(makeOptions()).catch((e) => e);

    expect(err).toBeInstanceOf(WizardError);
    expect((err as WizardError).exitCode).toBe(expectedExitCode);
  });
});

describe("runWizard — resumeWithRetry stale-step recovery", () => {
  const toolPayload: ToolPayload = {
    type: "tool",
    operation: "run-commands",
    cwd: "/tmp/test",
    params: { commands: ["npm install"] },
  };

  function makeStaleStepRun(
    resumeAsyncImpl: (
      args: Record<string, unknown>
    ) => Promise<WorkflowRunResult>
  ) {
    let runByIdRef: ReturnType<typeof mock>;
    getWorkflowSpy.mockImplementation(function (this: MastraClient) {
      capturedClientOptions.push(
        (
          this as unknown as {
            options: { abortSignal?: AbortSignal; retries?: number };
          }
        ).options
      );
      runByIdRef = runByIdMock;
      return {
        createRun: vi.fn(() =>
          Promise.resolve({
            runId: "test-run-id",
            startAsync: startAsyncMock,
            resumeAsync: vi.fn(async (args) =>
              withV1SuspendEnvelopes(await resumeAsyncImpl(args))
            ),
          })
        ),
        runById: runByIdRef,
      } as any;
    });
  }

  function httpError(
    status: number,
    body: unknown
  ): Error & { body: unknown; status: number } {
    return Object.assign(
      new Error(`HTTP error! status: ${status} - ${JSON.stringify(body)}`),
      { body, status }
    );
  }

  function staleStepError(status = 500): Error & { status: number } {
    return httpError(status, {
      error:
        "This workflow step 'tool-step' was not suspended. Available suspended steps: [next-step]",
    });
  }

  function staleRunError(status = 500): Error & { status: number } {
    return httpError(status, {
      error: "This workflow run was not suspended",
    });
  }

  function protocolConflictError(): Error & {
    body: unknown;
    status: number;
  } {
    return httpError(409, {
      code: "init_request_conflict",
      error: "The init tool result does not match the active suspended request",
    });
  }

  function selectWorkflowFields(
    result: WorkflowRunResult,
    fields: string[] | undefined
  ): Record<string, unknown> {
    const source = result as unknown as Record<string, unknown>;
    const selected: Record<string, unknown> = {};
    for (const field of fields ?? Object.keys(source)) {
      if (field in source) {
        selected[field] = source[field];
      }
    }
    return selected;
  }

  test("echoes the v1 request identity with the local tool result", async () => {
    const protocolPayload: SuspendPayload = {
      ...toolPayload,
      protocolVersion: 1,
      requestId: "8c7ee6b9-e955-4514-9164-f01844584a28",
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: protocolPayload } },
    };
    let capturedResume: Record<string, unknown> | undefined;
    makeStaleStepRun((args) => {
      capturedResume = args.resumeData as Record<string, unknown>;
      return Promise.resolve({ status: "success", result: { exitCode: 0 } });
    });

    await runWizard(makeOptions());

    expect(capturedResume).toMatchObject({
      protocolVersion: 1,
      requestId: protocolPayload.requestId,
    });
  });

  test("sends the explicit agent-checkpoint acknowledgement", async () => {
    const checkpointPayload: SuspendPayload = {
      cwd: "/tmp/test",
      detail: "Checking Sentry support for the detected project",
      operation: "agent-checkpoint",
      params: {},
      protocolVersion: 1,
      requestId: "5f61cbd5-1051-4b52-928f-06eb78ba40ee",
      type: "tool",
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["detect-platform"]],
      steps: {
        "detect-platform": { suspendPayload: checkpointPayload },
      },
    };
    executeToolSpy.mockResolvedValue({
      data: { acknowledged: true },
      ok: true,
    });
    let capturedResume: Record<string, unknown> | undefined;
    makeStaleStepRun((args) => {
      capturedResume = args.resumeData as Record<string, unknown>;
      return Promise.resolve({ status: "success", result: { exitCode: 0 } });
    });

    await runWizard(makeOptions());

    expect(executeToolSpy).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "agent-checkpoint" }),
      expect.anything()
    );
    expect(capturedResume).toMatchObject({
      data: { acknowledged: true },
      ok: true,
      protocolVersion: 1,
      requestId: checkpointPayload.requestId,
    });
  });

  test("uses request identity instead of mutable payload details during recovery", async () => {
    vi.useFakeTimers();
    const requestId = "8c7ee6b9-e955-4514-9164-f01844584a28";
    const protocolPayload: SuspendPayload = {
      ...toolPayload,
      protocolVersion: 1,
      requestId,
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: protocolPayload } },
    };
    runByIdMock
      .mockResolvedValueOnce({
        status: "suspended",
        suspendPayload: { ...protocolPayload, detail: "new display text" },
      })
      .mockResolvedValueOnce({
        status: "success",
        result: { exitCode: 0 },
      });
    let resumeCount = 0;
    makeStaleStepRun(() => {
      resumeCount += 1;
      return Promise.reject(staleRunError(409));
    });

    const run = runWizard(makeOptions());
    await vi.advanceTimersByTimeAsync(250);
    await run;

    expect(runByIdMock).toHaveBeenCalledTimes(2);
    expect(resumeCount).toBe(1);
  });

  test("recovers from a sparse 409 stale-resume conflict", async () => {
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: toolPayload } },
    };
    const currentRunState: WorkflowRunResult = {
      status: "success",
      result: { exitCode: 0 },
      suspended: [],
    };
    runByIdMock.mockImplementation(
      (_runId: string, opts?: { fields?: string[] }) =>
        Promise.resolve(selectWorkflowFields(currentRunState, opts?.fields))
    );

    let resumeCount = 0;
    makeStaleStepRun(() => {
      resumeCount += 1;
      if (resumeCount === 1) {
        return Promise.reject(staleStepError(409));
      }
      return Promise.resolve({ status: "success", result: { exitCode: 0 } });
    });

    await runWizard(makeOptions());

    expect(formatResultSpy).toHaveBeenCalled();
    expect(runByIdMock).toHaveBeenCalledWith(
      "test-run-id",
      expect.objectContaining({
        fields: expect.arrayContaining([
          "status",
          "suspended",
          "activeStepsPath",
        ]),
      })
    );
    // Recovery succeeded on the first attempt — resumeAsync was not called again.
    expect(resumeCount).toBe(1);
  });

  test("recovers from a v1 request-correlation conflict", async () => {
    const protocolPayload: SuspendPayload = {
      ...toolPayload,
      protocolVersion: 1,
      requestId: "8c7ee6b9-e955-4514-9164-f01844584a28",
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: protocolPayload } },
    };
    runByIdMock.mockResolvedValue({
      status: "success",
      result: { exitCode: 0 },
      suspended: [],
    });
    let resumeCount = 0;
    makeStaleStepRun(() => {
      resumeCount += 1;
      return Promise.reject(protocolConflictError());
    });

    await runWizard(makeOptions());

    expect(runByIdMock).toHaveBeenCalledTimes(1);
    expect(resumeCount).toBe(1);
  });

  test("keeps polling when runById returns the same suspended payload snapshot", async () => {
    vi.useFakeTimers();
    const protocolPayload: SuspendPayload = {
      ...toolPayload,
      protocolVersion: 1,
      requestId: "8c7ee6b9-e955-4514-9164-f01844584a28",
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: protocolPayload } },
    };
    runByIdMock
      .mockResolvedValueOnce({
        status: "suspended",
        suspendPayload: protocolPayload,
      })
      .mockResolvedValueOnce({
        status: "success",
        result: { exitCode: 0 },
      });

    let resumeCount = 0;
    makeStaleStepRun(() => {
      resumeCount += 1;
      return Promise.reject(staleRunError(409));
    });

    const run = runWizard(makeOptions());
    await vi.advanceTimersByTimeAsync(250);
    await run;

    expect(formatResultSpy).toHaveBeenCalled();
    expect(runByIdMock).toHaveBeenCalledTimes(2);
    expect(resumeCount).toBe(1);
  });

  test("uses active recovered payload instead of stale historical step payloads", async () => {
    const stalePayload: ToolPayload = {
      type: "tool",
      operation: "read-files",
      cwd: "/tmp/test",
      params: { paths: ["old-package.json"], resultVersion: 2 },
    };
    const activePayload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["echo apply"] },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: toolPayload } },
    };
    mockRunByIdResult = {
      status: "suspended",
      suspended: [["discover-context"]],
      activeStepsPath: { "apply-codemods": [] },
      steps: {
        "discover-context": { suspendPayload: stalePayload },
        "apply-codemods": { suspendPayload: activePayload },
      },
    };

    let resumeCount = 0;
    makeStaleStepRun(() => {
      resumeCount += 1;
      if (resumeCount === 1) {
        return Promise.reject(staleStepError());
      }
      return Promise.resolve({ status: "success", result: { exitCode: 0 } });
    });

    await runWizard(makeOptions());

    expect(executeToolSpy).toHaveBeenCalledWith(toolPayload, makeContext());
    expect(executeToolSpy).toHaveBeenCalledWith(activePayload, makeContext());
    expect(executeToolSpy).not.toHaveBeenCalledWith(
      stalePayload,
      makeContext()
    );
    expect(resumeCount).toBe(2);
  });

  test("does not replay non-stale HTTP 500 resume responses", async () => {
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: toolPayload } },
    };

    let resumeCount = 0;
    makeStaleStepRun(() => {
      resumeCount += 1;
      return Promise.reject(httpError(500, { error: "Error calling handler" }));
    });

    await expect(runWizard(makeOptions())).rejects.toThrow(WizardError);

    expect(resumeCount).toBe(1);
    expect(runByIdMock).not.toHaveBeenCalled();
  });

  test("classifies resumeAsync 401 instead of recovering as a transport failure", async () => {
    await useSaaSOAuthAuth();
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: toolPayload } },
    };

    let resumeCount = 0;
    makeStaleStepRun(() => {
      resumeCount += 1;
      return Promise.reject(initService401Error());
    });

    try {
      const err = await runWizard(makeOptions()).catch((error) => error);

      expect(err).toMatchObject(
        initServiceApiErrorShape("/api/workflows/sentry-wizard/resume-async")
      );
      expect(hasExpectedInitServiceAuthPolicy(err)).toBe(true);
      expect(err).not.toBeInstanceOf(WizardError);
      expect(resumeCount).toBe(1);
      expect(runByIdMock).not.toHaveBeenCalled();
      expect(spinnerMock.stop).toHaveBeenCalledWith("Authentication failed", 1);
      expect(err.format()).toContain("sentry auth login");
      expect(lastError()).toBeUndefined();
      expect(lastCancelMessage()).toBe("Authentication failed");
    } finally {
      await clearAuth();
    }
  });

  test("observes run state after a resume timeout without replaying resumeAsync", async () => {
    vi.useFakeTimers();
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: toolPayload } },
    };
    mockRunByIdResult = { status: "success", result: { exitCode: 0 } };

    let resumeCount = 0;
    makeStaleStepRun(() => {
      resumeCount += 1;
      return new Promise<WorkflowRunResult>(() => {
        /* Simulate a response that never arrives. */
      });
    });

    const run = runWizard(makeOptions());
    await vi.advanceTimersByTimeAsync(209_999);
    expect(runByIdMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(formatResultSpy).toHaveBeenCalled();
    expect(resumeCount).toBe(1);
    expect(runByIdMock).toHaveBeenCalledTimes(1);
  });

  test("throws when stale-step error occurs and runById keeps failing", async () => {
    vi.useFakeTimers();
    mockStartResult = {
      status: "suspended",
      suspended: [["tool-step"]],
      steps: { "tool-step": { suspendPayload: toolPayload } },
    };
    // runById is unreachable — recovery fails, wizard throws without retrying
    // the stale resume request.
    mockRunByIdResult = new Error("runById network error");

    let resumeCount = 0;
    makeStaleStepRun(() => {
      resumeCount += 1;
      return Promise.reject(staleStepError());
    });

    const run = runWizard(makeOptions());
    const rejection = expect(run).rejects.toThrow(WizardError);
    await vi.runAllTimersAsync();
    await rejection;

    // Threw after recovery polling failed — no futile retries of the stale step.
    expect(resumeCount).toBe(1);
    expect(runByIdMock).toHaveBeenCalled();
  });

  test("sends compact _prevPhases only for apply-codemods", async () => {
    const largeContent = "x".repeat(10_000);
    const readPayload: ToolPayload = {
      type: "tool",
      operation: "read-files",
      cwd: "/tmp/test",
      params: { paths: ["package.json"], resultVersion: 2 },
    };
    const applyPayload: ToolPayload = {
      type: "tool",
      operation: "apply-patchset",
      cwd: "/tmp/test",
      params: { patches: [] },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["apply-codemods"]],
      steps: { "apply-codemods": { suspendPayload: readPayload } },
    };
    executeToolSpy
      .mockResolvedValueOnce({
        ok: true,
        data: {
          files: {
            "package.json": {
              content: largeContent,
              status: "ok",
              truncated: false,
            },
          },
          version: 2,
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "patch conflict",
      });

    const resumeArgs: Record<string, unknown>[] = [];
    makeStaleStepRun((args) => {
      resumeArgs.push(args);
      if (resumeArgs.length === 1) {
        return Promise.resolve({
          status: "suspended",
          suspended: [["apply-codemods"]],
          steps: { "apply-codemods": { suspendPayload: applyPayload } },
        });
      }
      return Promise.resolve({ status: "success", result: { exitCode: 0 } });
    });

    await runWizard(makeOptions());

    const secondResumeData = resumeArgs[1]?.resumeData as
      | Record<string, unknown>
      | undefined;
    expect(secondResumeData?._prevPhases).toEqual([
      {
        ok: true,
        operation: "read-files",
        _phase: "read-files",
        data: { files: { "package.json": null } },
      },
    ]);
    expect(JSON.stringify(secondResumeData?._prevPhases)).not.toContain(
      largeContent
    );
  });
});

describe("runWizard — additional coverage", () => {
  test("throws WizardError and stops spinner when workflow start fails", async () => {
    startAsyncMock.mockRejectedValue(new Error("connection refused"));

    await expect(runWizard(makeOptions())).rejects.toThrow(WizardError);

    expect(spinnerMock.stop).toHaveBeenCalledWith("Connection failed", 1);
    expect(lastCancelMessage()).toBe("Setup failed");
  });

  test("classifies init service 401 as expected OAuth auth state", async () => {
    await useSaaSOAuthAuth();
    startAsyncMock.mockRejectedValue(initService401Error());
    const captureSpy = vi.spyOn(Sentry, "captureException");

    try {
      const err = await runWizard(makeOptions()).catch((error) => error);

      expect(err).toMatchObject(
        initServiceApiErrorShape("/api/workflows/sentry-wizard/start-async")
      );
      expect(hasExpectedInitServiceAuthPolicy(err)).toBe(true);
      expect(err.format()).toContain("sentry auth login");
      expect(spinnerMock.stop).toHaveBeenCalledWith("Authentication failed", 1);
      expect(lastError()).toBeUndefined();
      expect(lastCancelMessage()).toBe("Authentication failed");
      expect(captureSpy).not.toHaveBeenCalled();
    } finally {
      captureSpy.mockRestore();
      await clearAuth();
    }
  });

  test("classifies createRun 401 before starting the workflow", async () => {
    await useSaaSOAuthAuth();
    const createRunMock = vi.fn(() => Promise.reject(initService401Error()));
    getWorkflowSpy.mockImplementation(function (this: MastraClient) {
      capturedClientOptions.push(
        (
          this as unknown as {
            options: { abortSignal?: AbortSignal; retries?: number };
          }
        ).options
      );
      return {
        createRun: createRunMock,
        runById: runByIdMock,
      } as any;
    });

    try {
      const err = await runWizard(makeOptions()).catch((error) => error);

      expect(err).toMatchObject(
        initServiceApiErrorShape("/api/workflows/sentry-wizard/create-run")
      );
      expect(hasExpectedInitServiceAuthPolicy(err)).toBe(true);
      expect(createRunMock).toHaveBeenCalledTimes(1);
      expect(startAsyncMock).not.toHaveBeenCalled();
      expect(err.format()).toContain("sentry auth login");
      expect(spinnerMock.stop).toHaveBeenCalledWith("Authentication failed", 1);
      expect(lastError()).toBeUndefined();
      expect(lastCancelMessage()).toBe("Authentication failed");
    } finally {
      await clearAuth();
    }
  });

  test("classifies init service 401 with env-token guidance", async () => {
    await clearAuth();
    const env = {
      ...process.env,
      SENTRY_AUTH_TOKEN: "env-token",
      SENTRY_FORCE_ENV_TOKEN: "1",
    };
    delete env.SENTRY_TOKEN;
    setEnv(env);
    resolveInitContextSpy.mockResolvedValue(
      makeContext({ authToken: "env-token" })
    );
    startAsyncMock.mockRejectedValue(initService401Error());

    try {
      const err = await runWizard(makeOptions()).catch((error) => error);

      expect(err).toMatchObject(
        initServiceApiErrorShape("/api/workflows/sentry-wizard/start-async")
      );
      expect(hasExpectedInitServiceAuthPolicy(err)).toBe(true);
      expect(err.format()).toContain("SENTRY_AUTH_TOKEN");
      expect(err.format()).toContain("not recognized or has been revoked");
      expect(err.format()).toContain("auth-tokens");
      expect(lastError()).toBeUndefined();
    } finally {
      setEnv(process.env);
      await clearAuth();
    }
  });

  test("blocks self-hosted tokens before constructing hosted init workflow", async () => {
    await clearAuth();
    setAuthToken("self-hosted-token", 3600, "refresh-token", {
      host: "https://sentry.internal.example.com",
    });
    resolveInitContextSpy.mockResolvedValue(
      makeContext({ authToken: "self-hosted-token" })
    );

    try {
      const err = await runWizard(makeOptions()).catch((error) => error);

      expect(err).toBeInstanceOf(HostScopeError);
      expect(getWorkflowSpy).not.toHaveBeenCalled();
      expect(startAsyncMock).not.toHaveBeenCalled();
      expect(capturedClientOptions).toHaveLength(0);
      expect(err.format()).toContain("sentry.internal.example.com");
      expect(err.format()).toContain(
        "sentry auth login --url https://sentry.io"
      );
    } finally {
      await clearAuth();
    }
  });

  test("throws when the workflow response has an unrecognised status", async () => {
    startAsyncMock.mockResolvedValue({ status: "bailed" });

    await expect(runWizard(makeOptions())).rejects.toThrow(
      /Unexpected workflow status/
    );
  });

  test("throws when a suspend payload is a non-object truthy value", async () => {
    mockStartResult = {
      status: "suspended",
      suspended: [["detect-platform"]],
      steps: {
        "detect-platform": {
          // 42 is truthy, so extractSuspendPayload passes it to
          // assertSuspendPayload, which rejects non-objects.
          suspendPayload: 42,
        },
      },
    };

    await expect(runWizard(makeOptions())).rejects.toThrow(WizardError);
  });

  test("does not use inactive step payloads when active step info exists", async () => {
    const payload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["echo hi"] },
    };
    // `suspended` points to "step-a", so the stale payload on "step-b"
    // must not be used.
    mockStartResult = {
      status: "suspended",
      suspended: [["step-a"]],
      steps: {
        "step-a": {},
        "step-b": { suspendPayload: payload },
      },
    };
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await expect(runWizard(makeOptions())).rejects.toThrow(WizardError);

    expect(executeToolSpy).not.toHaveBeenCalledWith(payload, makeContext());
  });

  test("uses the sole payload fallback when no active step info exists", async () => {
    const payload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["echo hi"] },
    };
    mockStartResult = {
      status: "suspended",
      steps: {
        "step-b": { suspendPayload: payload },
      },
    };
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions());

    expect(executeToolSpy).toHaveBeenCalledWith(payload, makeContext());
  });

  test("marks the previous step completed when the workflow advances", async () => {
    const payloadA: ToolPayload = {
      type: "tool",
      operation: "list-dir",
      cwd: "/tmp/test",
      params: { path: "." },
    };
    const payloadB: ToolPayload = {
      type: "tool",
      operation: "read-files",
      cwd: "/tmp/test",
      params: { paths: ["package.json"], resultVersion: 2 },
    };

    mockStartResult = {
      status: "suspended",
      suspended: [["discover-context"]],
      steps: { "discover-context": { suspendPayload: payloadA } },
    };
    mockResumeResults = [
      {
        status: "suspended",
        suspended: [["detect-platform"]],
        steps: { "detect-platform": { suspendPayload: payloadB } },
      },
      { status: "success", result: { exitCode: 0 } },
    ];

    await runWizard(makeOptions());

    const stepCalls = mockUICalls.filter((c) => c.kind === "setStep");
    expect(stepCalls).toContainEqual({
      kind: "setStep",
      stepId: "discover-context",
      status: "in_progress",
    });
    expect(stepCalls).toContainEqual({
      kind: "setStep",
      stepId: "discover-context",
      status: "completed",
    });
    expect(stepCalls).toContainEqual({
      kind: "setStep",
      stepId: "detect-platform",
      status: "in_progress",
    });
    const inProgressIdx = stepCalls.findIndex(
      (c) =>
        c.kind === "setStep" &&
        c.stepId === "discover-context" &&
        c.status === "in_progress"
    );
    const completedIdx = stepCalls.findIndex(
      (c) =>
        c.kind === "setStep" &&
        c.stepId === "discover-context" &&
        c.status === "completed"
    );
    expect(inProgressIdx).toBeLessThan(completedIdx);
  });

  test("uses server step results for tasks that finish without suspending", async () => {
    const payload: ToolPayload = {
      type: "tool",
      operation: "read-files",
      cwd: "/tmp/test",
      params: { paths: ["package.json"], resultVersion: 2 },
    };

    mockStartResult = {
      status: "suspended",
      suspended: [["detect-platform"]],
      steps: {
        "discover-context": { status: "success" },
        "detect-platform": { status: "suspended", suspendPayload: payload },
      },
    };
    mockResumeResults = [
      {
        status: "success",
        result: { exitCode: 0 },
        steps: {
          "discover-context": { status: "success" },
          "detect-platform": { status: "success" },
          "ensure-sentry-project": { status: "success" },
          "select-features": { status: "success" },
          "plan-codemods": { status: "success" },
          "apply-codemods": { status: "success" },
          "verify-changes": { status: "success" },
          "open-sentry-ui": { status: "success" },
        },
      },
    ];

    await runWizard(makeOptions());

    const stepCalls = mockUICalls.filter((call) => call.kind === "setStep");
    for (const stepId of CHECKLIST_VISIBLE_STEPS) {
      expect(stepCalls).toContainEqual({
        kind: "setStep",
        stepId,
        status: "completed",
      });
    }
    expect(stepCalls).not.toContainEqual(
      expect.objectContaining({ stepId: "install-deps" })
    );

    const discoverCompletedIndex = stepCalls.findIndex(
      (call) =>
        call.kind === "setStep" &&
        call.stepId === "discover-context" &&
        call.status === "completed"
    );
    const detectStartedIndex = stepCalls.findIndex(
      (call) =>
        call.kind === "setStep" &&
        call.stepId === "detect-platform" &&
        call.status === "in_progress"
    );
    expect(discoverCompletedIndex).toBeLessThan(detectStartedIndex);
  });

  test("marks a server-reported failure before any step suspends", async () => {
    mockStartResult = {
      status: "failed",
      error: "Framework detection failed",
      steps: {
        "discover-context": { status: "success" },
        "detect-platform": { status: "failed" },
      },
    };

    await expect(runWizard(makeOptions())).rejects.toThrow(
      "Framework detection failed"
    );

    expect(mockUICalls).toContainEqual({
      kind: "setStep",
      stepId: "discover-context",
      status: "completed",
    });
    expect(mockUICalls).toContainEqual({
      kind: "setStep",
      stepId: "detect-platform",
      status: "failed",
    });
  });

  test("uses existing platform name in detect-platform spinner label", async () => {
    resolveInitContextSpy.mockResolvedValue(
      makeContext({ existingProject: { platform: "javascript-nextjs" } })
    );
    mockStartResult = {
      status: "suspended",
      suspended: [["detect-platform"]],
      steps: {
        "detect-platform": {
          suspendPayload: {
            type: "tool",
            operation: "list-dir",
            cwd: "/tmp/test",
            params: { path: "." },
          },
        },
      },
    };
    mockResumeResults = [{ status: "success", result: { exitCode: 0 } }];

    await runWizard(makeOptions());

    const messages = spinnerMock.message.mock.calls.map(
      (c: unknown[]) => c[0] as string
    );
    expect(messages.some((m) => m.includes("javascript-nextjs"))).toBe(true);
  });
});

describe("runWizard — progress rotation for long-running steps", () => {
  test("rotates spinner messages during plan-codemods resume", async () => {
    vi.useFakeTimers();
    const toolPayload = {
      type: "tool" as const,
      operation: "read-files",
      cwd: "/tmp/test",
      params: { paths: ["src/app.tsx"], resultVersion: 2 },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["plan-codemods"]],
      steps: { "plan-codemods": { suspendPayload: toolPayload } },
    };

    // resumeAsync will block until we advance timers, then resolve
    let resolveResume!: (value: unknown) => void;
    const resumePromise = new Promise((resolve) => {
      resolveResume = resolve;
    });
    const resumeAsyncMock = vi.fn(() => resumePromise);
    getWorkflowSpy.mockImplementation(function (this: MastraClient) {
      capturedClientOptions.push(
        (
          this as unknown as {
            options: { abortSignal?: AbortSignal; retries?: number };
          }
        ).options
      );
      return {
        createRun: vi.fn(() =>
          Promise.resolve({
            runId: "test-run-id",
            startAsync: startAsyncMock,
            resumeAsync: resumeAsyncMock,
          })
        ),
        runById: runByIdMock,
      } as any;
    });

    const runPromise = runWizard(makeOptions());

    // Let the wizard start and reach the resume call
    await vi.advanceTimersByTimeAsync(100);

    // Advance past one rotation interval
    await vi.advanceTimersByTimeAsync(12_000);

    // Check that the spinner received a rotating message
    const messagesAfterFirstRotation = spinnerMock.message.mock.calls.map(
      (c: unknown[]) => c[0] as string
    );
    expect(
      messagesAfterFirstRotation.some((m) =>
        m.includes("Fetching SDK documentation")
      )
    ).toBe(true);

    // Advance past another rotation interval
    await vi.advanceTimersByTimeAsync(12_000);

    const messagesAfterSecondRotation = spinnerMock.message.mock.calls.map(
      (c: unknown[]) => c[0] as string
    );
    expect(
      messagesAfterSecondRotation.some((m) =>
        m.includes("Analyzing integration requirements")
      )
    ).toBe(true);

    // Resolve the resume and let the wizard finish
    resolveResume({ status: "success", result: { exitCode: 0 } });
    await vi.advanceTimersByTimeAsync(100);
    await runPromise;
  });

  test("appends elapsed time after exhausting all progress messages", async () => {
    vi.useFakeTimers();
    const toolPayload = {
      type: "tool" as const,
      operation: "read-files",
      cwd: "/tmp/test",
      params: { paths: ["src/app.tsx"], resultVersion: 2 },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["plan-codemods"]],
      steps: { "plan-codemods": { suspendPayload: toolPayload } },
    };

    let resolveResume!: (value: unknown) => void;
    const resumePromise = new Promise((resolve) => {
      resolveResume = resolve;
    });
    const resumeAsyncMock = vi.fn(() => resumePromise);
    getWorkflowSpy.mockImplementation(function (this: MastraClient) {
      capturedClientOptions.push(
        (
          this as unknown as {
            options: { abortSignal?: AbortSignal; retries?: number };
          }
        ).options
      );
      return {
        createRun: vi.fn(() =>
          Promise.resolve({
            runId: "test-run-id",
            startAsync: startAsyncMock,
            resumeAsync: resumeAsyncMock,
          })
        ),
        runById: runByIdMock,
      } as any;
    });

    const runPromise = runWizard(makeOptions());
    await vi.advanceTimersByTimeAsync(100);

    // Advance past all 5 plan-codemods messages (5 * 12s = 60s)
    // plus one more interval to trigger the elapsed time display
    await vi.advanceTimersByTimeAsync(72_000);

    const messages = spinnerMock.message.mock.calls.map(
      (c: unknown[]) => c[0] as string
    );
    // After exhausting messages, should show elapsed time
    expect(messages.some((m) => /\(\d+s\)/.test(m))).toBe(true);

    resolveResume({ status: "success", result: { exitCode: 0 } });
    await vi.advanceTimersByTimeAsync(100);
    await runPromise;
  });

  test("does not rotate messages for steps without progress messages", async () => {
    vi.useFakeTimers();
    const toolPayload = {
      type: "tool" as const,
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["npm install @sentry/node"] },
    };
    mockStartResult = {
      status: "suspended",
      suspended: [["apply-codemods"]],
      steps: { "apply-codemods": { suspendPayload: toolPayload } },
    };

    let resolveResume!: (value: unknown) => void;
    const resumePromise = new Promise((resolve) => {
      resolveResume = resolve;
    });
    const resumeAsyncMock = vi.fn(() => resumePromise);
    getWorkflowSpy.mockImplementation(function (this: MastraClient) {
      capturedClientOptions.push(
        (
          this as unknown as {
            options: { abortSignal?: AbortSignal; retries?: number };
          }
        ).options
      );
      return {
        createRun: vi.fn(() =>
          Promise.resolve({
            runId: "test-run-id",
            startAsync: startAsyncMock,
            resumeAsync: resumeAsyncMock,
          })
        ),
        runById: runByIdMock,
      } as any;
    });

    const runPromise = runWizard(makeOptions());
    await vi.advanceTimersByTimeAsync(100);

    const messagesBefore = spinnerMock.message.mock.calls.length;

    // Advance past a rotation interval
    await vi.advanceTimersByTimeAsync(12_000);

    const messagesAfter = spinnerMock.message.mock.calls.length;
    // No new messages should have been added by the rotation timer
    expect(messagesAfter).toBe(messagesBefore);

    resolveResume({ status: "success", result: { exitCode: 0 } });
    await vi.advanceTimersByTimeAsync(100);
    await runPromise;
  });
});
