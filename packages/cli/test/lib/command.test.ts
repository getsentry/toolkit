/**
 * Command Builder Tests
 *
 * Tests for the buildCommand wrapper that adds automatic flag telemetry.
 * Uses Stricli's run() to invoke commands end-to-end, verifying the wrapper
 * captures flags/args and calls the original function.
 */

import { setTimeout as sleep } from "node:timers/promises";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import {
  buildApplication,
  type CommandContext,
  run,
  text_en,
} from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyLoggingFlags,
  applyOrgProjectFlags,
  buildCommand,
  FIELDS_FLAG,
  JSON_FLAG,
  LOG_LEVEL_FLAG,
  numberParser,
  VERBOSE_FLAG,
} from "../../src/lib/command.js";
import { EXIT, OutputError } from "../../src/lib/errors.js";
import { CommandOutput } from "../../src/lib/formatters/output.js";
import {
  interactivePromptsAllowed,
  setInteractivePromptsAllowed,
} from "../../src/lib/interactive-prompts.js";
import { LOG_LEVEL_NAMES, logger, setLogLevel } from "../../src/lib/logger.js";
import { DRY_RUN_FLAG, YES_FLAG } from "../../src/lib/mutate-command.js";
import { resolveOrgAndProject } from "../../src/lib/resolve-target.js";
import { buildRouteMap } from "../../src/lib/route-map.js";

/** Minimal context for test commands */
type TestContext = CommandContext & {
  process: { stdout: { write: (s: string) => boolean } };
  /** stdout on context — used by buildCommand's return-based output handler */
  stdout: { write: (s: string) => boolean };
};

/**
 * Creates a minimal test context with writable streams.
 * Returns both `process` (Stricli needs this) and `stdout` (return-based output handler needs this).
 *
 * Use as: `const ctx = createTestContext();`
 * Then pass to `run(app, args, ctx as TestContext)`.
 * Access collected output via `ctx.output`.
 */
function createTestContext() {
  const stdoutCollected: string[] = [];
  const stderrCollected: string[] = [];
  const stdoutWriter = {
    write: (s: string) => {
      stdoutCollected.push(s);
      return true;
    },
  };
  return {
    process: {
      stdout: stdoutWriter,
      stderr: {
        write: (s: string) => {
          stderrCollected.push(s);
          return true;
        },
      },
    },
    /** stdout on context — used by buildCommand's return-based output handler */
    stdout: stdoutWriter,
    /** stdout output chunks only */
    output: stdoutCollected,
    /** stderr output chunks only */
    errors: stderrCollected,
  };
}

test("derives prompt availability from parsed flags instead of ambiguous aliases", async () => {
  type InitPromptFlags = { yes: boolean; "dry-run": boolean };
  type DataFlags = { limit?: number; row?: number };
  const promptStates: boolean[] = [];

  const initCommand = buildCommand<InitPromptFlags, [], TestContext>({
    auth: false,
    docs: { brief: "Init" },
    parameters: {
      flags: { yes: YES_FLAG, "dry-run": DRY_RUN_FLAG },
      aliases: { y: "yes", n: "dry-run" },
    },
    // biome-ignore lint/correctness/useYield: test command only observes wrapper state
    async *func() {
      promptStates.push(interactivePromptsAllowed());
    },
  });
  const dataCommand = buildCommand<DataFlags, [], TestContext>({
    auth: false,
    docs: { brief: "Data" },
    parameters: {
      flags: {
        limit: {
          kind: "parsed",
          parse: numberParser,
          brief: "Limit",
          optional: true,
        },
        row: {
          kind: "parsed",
          parse: numberParser,
          brief: "Row",
          optional: true,
        },
      },
      aliases: { n: "limit", y: "row" },
    },
    // biome-ignore lint/correctness/useYield: test command only observes wrapper state
    async *func() {
      promptStates.push(interactivePromptsAllowed());
    },
  });
  const routeMap = buildRouteMap({
    routes: { init: initCommand, data: dataCommand },
    docs: { brief: "Test app" },
  });
  const app = buildApplication(routeMap, { name: "test" });
  const ctx = createTestContext();
  const cases: Array<{
    args: string[];
    expected: boolean;
  }> = [
    { args: ["init", "-y"], expected: false },
    { args: ["init", "-n"], expected: false },
    { args: ["init", "--yes=false"], expected: true },
    { args: ["data", "-n", "10"], expected: true },
    { args: ["data", "-y", "2"], expected: true },
  ];

  try {
    for (const testCase of cases) {
      await run(app, testCase.args, ctx as TestContext);
      expect(promptStates.at(-1)).toBe(testCase.expected);
    }
  } finally {
    setInteractivePromptsAllowed(true);
  }
});

describe("buildCommand", () => {
  test("builds a valid command object", () => {
    const command = buildCommand({
      auth: false,
      docs: { brief: "Test command" },
      parameters: {
        flags: {
          verbose: { kind: "boolean", brief: "Verbose", default: false },
        },
      },
      async *func(_flags: { verbose: boolean }) {
        // no-op
      },
    });
    expect(command).toBeDefined();
  });

  test("handles commands with empty parameters", () => {
    const command = buildCommand({
      auth: false,
      docs: { brief: "Simple command" },
      parameters: {},
      async *func() {
        // no-op
      },
    });
    expect(command).toBeDefined();
  });

  test("retains the primary custom usage line for introspection", () => {
    const command = buildCommand<Record<string, never>, string[]>({
      auth: false,
      docs: {
        brief: "Create things",
        customUsage: ["<name>:<kind>..."],
      },
      parameters: {
        positional: {
          kind: "array",
          parameter: { brief: "Name and kind pairs", parse: String },
        },
      },
      async *func() {
        yield null;
      },
    });

    expect(
      (command as unknown as { __primaryUsage?: string }).__primaryUsage
    ).toBe("<name>:<kind>...");
  });

  test("re-exports numberParser from Stricli", () => {
    expect(numberParser).toBeDefined();
    expect(typeof numberParser).toBe("function");
  });
});

describe("buildCommand telemetry integration", () => {
  let setTagSpy: ReturnType<typeof spyOn>;
  let setContextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setTagSpy = vi.spyOn(Sentry, "setTag");
    setContextSpy = vi.spyOn(Sentry, "setContext");
  });

  afterEach(() => {
    setTagSpy.mockRestore();
    setContextSpy.mockRestore();
  });

  test("captures flags as Sentry tags when command runs", async () => {
    let calledWith: unknown = null;

    const command = buildCommand<
      { verbose: boolean; limit: number },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          verbose: { kind: "boolean", brief: "Verbose", default: false },
          limit: {
            kind: "parsed",
            parse: numberParser,
            brief: "Limit",
            default: "10",
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        flags: { verbose: boolean; limit: number }
      ) {
        calledWith = flags;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--verbose", "--limit", "50"], ctx as TestContext);

    // Original func was called with parsed flags
    expect(calledWith).toEqual({ verbose: true, limit: 50 });

    // Sentry.setTag was called for meaningful flag values
    expect(setTagSpy).toHaveBeenCalledWith("flag.verbose", "true");
    expect(setTagSpy).toHaveBeenCalledWith("flag.limit", "50");
  });

  test("passes string defaults through parse() — numberParser default is number at runtime", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    const command = buildCommand<{ limit: number }, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          limit: {
            kind: "parsed",
            parse: numberParser,
            brief: "Limit",
            default: "10",
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(this: TestContext, flags: { limit: number }) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    // Run WITHOUT --limit to exercise the default path
    await run(app, ["test"], ctx as TestContext);

    expect(receivedFlags).not.toBeNull();
    // Critical: must be number 10, not string "10"
    expect(receivedFlags!.limit).toBe(10);
    expect(typeof receivedFlags!.limit).toBe("number");
  });

  test("skips false boolean flags in telemetry", async () => {
    const command = buildCommand<{ json: boolean }, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          json: { kind: "boolean", brief: "JSON output", default: false },
        },
      },
      async *func(_flags: { json: boolean }) {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test"], ctx as TestContext);

    // Should not set tag for default false boolean
    const flagCalls = setTagSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].startsWith("flag.")
    );
    expect(flagCalls).toHaveLength(0);
  });

  test("captures positional args as Sentry context", async () => {
    let calledArgs: unknown = null;

    const command = buildCommand<Record<string, never>, [string], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        positional: {
          kind: "tuple",
          parameters: [{ brief: "Issue ID", parse: String }],
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        _flags: Record<string, never>,
        issueId: string
      ) {
        calledArgs = issueId;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "PROJECT-123"], ctx as TestContext);

    expect(calledArgs).toBe("PROJECT-123");
    expect(setContextSpy).toHaveBeenCalledWith("args", {
      values: ["PROJECT-123"],
      count: 1,
    });
  });

  test("preserves this context for command functions", async () => {
    let capturedStdout = false;

    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(this: TestContext) {
        // Verify 'this' is correctly bound to context
        capturedStdout = typeof this.process.stdout.write === "function";
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test"], ctx as TestContext);

    expect(capturedStdout).toBe(true);
  });

  test("handles async command functions", async () => {
    let executed = false;

    const command = buildCommand<{ delay: number }, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          delay: {
            kind: "parsed",
            parse: numberParser,
            brief: "Delay ms",
            default: "1",
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(_flags: { delay: number }) {
        await sleep(1);
        executed = true;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--delay", "1"], ctx as TestContext);

    expect(executed).toBe(true);
    expect(setTagSpy).toHaveBeenCalledWith("flag.delay", "1");
  });
});

// ---------------------------------------------------------------------------
// Global logging flag definitions
// ---------------------------------------------------------------------------

describe("LOG_LEVEL_FLAG", () => {
  test("is an enum flag with all log level names", () => {
    expect(LOG_LEVEL_FLAG.kind).toBe("enum");
    expect(LOG_LEVEL_FLAG.values).toEqual([...LOG_LEVEL_NAMES]);
  });

  test("is optional and hidden", () => {
    expect(LOG_LEVEL_FLAG.optional).toBe(true);
    expect(LOG_LEVEL_FLAG.hidden).toBe(true);
  });
});

describe("VERBOSE_FLAG", () => {
  test("is a boolean flag defaulting to false", () => {
    expect(VERBOSE_FLAG.kind).toBe("boolean");
    expect(VERBOSE_FLAG.default).toBe(false);
  });

  test("is hidden", () => {
    expect(VERBOSE_FLAG.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyLoggingFlags
// ---------------------------------------------------------------------------

describe("applyLoggingFlags", () => {
  let originalLevel: number;

  beforeEach(() => {
    originalLevel = logger.level;
  });

  afterEach(() => {
    setLogLevel(originalLevel);
  });

  test("sets level from logLevel flag", () => {
    applyLoggingFlags("debug", false);
    expect(logger.level).toBe(4);
  });

  test("sets level from verbose flag", () => {
    applyLoggingFlags(undefined, true);
    expect(logger.level).toBe(4); // debug
  });

  test("logLevel takes priority over verbose", () => {
    applyLoggingFlags("error", true);
    expect(logger.level).toBe(0); // error, not debug
  });

  test("does nothing when both are unset/false", () => {
    const before = logger.level;
    applyLoggingFlags(undefined, false);
    expect(logger.level).toBe(before);
  });

  test("accepts all valid level names", () => {
    for (const name of LOG_LEVEL_NAMES) {
      applyLoggingFlags(name, false);
      expect(logger.level).toBe(LOG_LEVEL_NAMES.indexOf(name));
    }
  });
});

// ---------------------------------------------------------------------------
// buildCommand
// ---------------------------------------------------------------------------

describe("buildCommand", () => {
  let originalLevel: number;

  beforeEach(() => {
    originalLevel = logger.level;
  });

  afterEach(() => {
    setLogLevel(originalLevel);
  });

  test("builds a valid command object", () => {
    const command = buildCommand({
      auth: false,
      docs: { brief: "Test command" },
      parameters: {
        flags: {
          json: { kind: "boolean", brief: "JSON output", default: false },
        },
      },
      async *func(_flags: { json: boolean }) {
        // no-op
      },
    });
    expect(command).toBeDefined();
  });

  test("accepts --verbose and --log-level flags without error", async () => {
    let calledFlags: Record<string, unknown> | null = null;

    const command = buildCommand<{ json: boolean }, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          json: { kind: "boolean", brief: "JSON output", default: false },
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(this: TestContext, flags: { json: boolean }) {
        calledFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    // Should NOT throw "No flag registered for --verbose"
    await run(app, ["test", "--verbose", "--json"], ctx as TestContext);

    // Original func receives json flag but NOT verbose/log-level
    expect(calledFlags).toBeDefined();
    expect(calledFlags!.json).toBe(true);
    expect(calledFlags!.verbose).toBeUndefined();
    expect(calledFlags!["log-level"]).toBeUndefined();
  });

  test("--verbose sets logger to debug level", async () => {
    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      async *func() {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--verbose"], ctx as TestContext);

    expect(logger.level).toBe(4); // debug
  });

  test("--log-level sets logger to specified level", async () => {
    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      async *func() {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--log-level", "trace"], ctx as TestContext);

    expect(logger.level).toBe(5); // trace
  });

  test("--log-level=value (equals form) works", async () => {
    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      async *func() {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--log-level=error"], ctx as TestContext);

    expect(logger.level).toBe(0); // error
  });

  test("strips logging flags from func's flags parameter", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    const command = buildCommand<{ limit: number }, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          limit: {
            kind: "parsed",
            parse: numberParser,
            brief: "Limit",
            default: "10",
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(this: TestContext, flags: { limit: number }) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(
      app,
      ["test", "--verbose", "--log-level", "debug", "--limit", "50"],
      ctx as TestContext
    );

    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.limit).toBe(50);
    // Logging flags must be stripped
    expect(receivedFlags!.verbose).toBeUndefined();
    expect(receivedFlags!["log-level"]).toBeUndefined();
  });

  test("preserves command's own --verbose flag when already defined", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    // Simulates the api command: defines its own --verbose with HTTP semantics
    const command = buildCommand<
      { verbose: boolean; silent: boolean },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          verbose: {
            kind: "boolean",
            brief: "Show HTTP details",
            default: false,
          },
          silent: {
            kind: "boolean",
            brief: "Suppress output",
            default: false,
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        flags: { verbose: boolean; silent: boolean }
      ) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(
      app,
      ["test", "--verbose", "--log-level", "trace"],
      ctx as TestContext
    );

    // Command's own --verbose is passed through (not stripped)
    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.verbose).toBe(true);
    expect(receivedFlags!.silent).toBe(false);
    // --log-level is always stripped (it's ours)
    expect(receivedFlags!["log-level"]).toBeUndefined();
    // --verbose also sets debug-level logging as a side-effect
    // but --log-level=trace takes priority
    expect(logger.level).toBe(5); // trace
  });

  test("command's own --verbose sets debug log level as side-effect", async () => {
    const command = buildCommand<{ verbose: boolean }, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          verbose: {
            kind: "boolean",
            brief: "Show HTTP details",
            default: false,
          },
        },
      },
      async *func() {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--verbose"], ctx as TestContext);

    // Even though verbose is command-owned, it triggers debug-level logging
    expect(logger.level).toBe(4); // debug
  });
});

// ---------------------------------------------------------------------------
// JSON_FLAG and FIELDS_FLAG definitions
// ---------------------------------------------------------------------------

describe("JSON_FLAG", () => {
  test("is a boolean flag defaulting to false", () => {
    expect(JSON_FLAG.kind).toBe("boolean");
    expect(JSON_FLAG.default).toBe(false);
  });

  test("is not hidden", () => {
    expect("hidden" in JSON_FLAG).toBe(false);
  });
});

describe("FIELDS_FLAG", () => {
  test("is a parsed optional flag", () => {
    expect(FIELDS_FLAG.kind).toBe("parsed");
    expect(FIELDS_FLAG.optional).toBe(true);
  });

  test("parses input as string", () => {
    expect(FIELDS_FLAG.parse("id,title")).toBe("id,title");
  });
});

// ---------------------------------------------------------------------------
// buildCommand output config injection
// ---------------------------------------------------------------------------

describe("buildCommand output config", () => {
  let originalLevel: number;

  beforeEach(() => {
    originalLevel = logger.level;
  });

  afterEach(() => {
    setLogLevel(originalLevel);
  });

  test("injects --json flag when output: 'json'", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: { human: () => "unused" },
      parameters: {
        flags: {
          limit: {
            kind: "parsed",
            parse: numberParser,
            brief: "Limit",
            default: "10",
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        flags: { json: boolean; fields?: string[] }
      ) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    // --json should be accepted without "No flag registered" error
    await run(app, ["test", "--json"], ctx as TestContext);

    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.json).toBe(true);
  });

  test("injects --fields flag when output: 'json'", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: { human: () => "unused" },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        flags: { json: boolean; fields?: string[] }
      ) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(
      app,
      ["test", "--json", "--fields", "id,title,status"],
      ctx as TestContext
    );

    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.json).toBe(true);
    // --fields is pre-parsed from comma-string to string[]
    expect(receivedFlags!.fields).toEqual(["id", "title", "status"]);
  });

  test("pre-parses --fields with whitespace and deduplication", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: { human: () => "unused" },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        flags: { json: boolean; fields?: string[] }
      ) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(
      app,
      ["test", "--fields", " id , title , id "],
      ctx as TestContext
    );

    expect(receivedFlags).toBeDefined();
    // Whitespace trimmed, duplicates removed
    expect(receivedFlags!.fields).toEqual(["id", "title"]);
  });

  test("fields is undefined when --fields not passed", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: { human: () => "unused" },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        flags: { json: boolean; fields?: string[] }
      ) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--json"], ctx as TestContext);

    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.json).toBe(true);
    expect(receivedFlags!.fields).toBeUndefined();
  });

  test("does not inject --json/--fields without output: 'json'", async () => {
    let funcCalled = false;

    // Command WITHOUT output config — --json should be rejected by Stricli
    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func() {
        funcCalled = true;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    // Stricli writes error to stderr and resolves — func is never called
    await run(app, ["test", "--json"], ctx as TestContext);

    expect(funcCalled).toBe(false);
    expect(
      ctx.errors.some((s) => s.includes("No flag registered for --json"))
    ).toBe(true);
  });

  test("preserves command's own --json flag when already defined", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    // Command defines its own --json with custom brief
    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: { human: () => "unused" },
      parameters: {
        flags: {
          json: {
            kind: "boolean",
            brief: "Custom JSON brief text",
            default: false,
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        flags: { json: boolean; fields?: string[] }
      ) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--json", "--fields", "id"], ctx as TestContext);

    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.json).toBe(true);
    // --fields is still injected and pre-parsed even when command owns --json
    expect(receivedFlags!.fields).toEqual(["id"]);
  });

  test("supports dot-notation in --fields", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: { human: () => "unused" },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        flags: { json: boolean; fields?: string[] }
      ) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(
      app,
      ["test", "--fields", "id,metadata.value,contexts.trace.traceId"],
      ctx as TestContext
    );

    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.fields).toEqual([
      "id",
      "metadata.value",
      "contexts.trace.traceId",
    ]);
  });

  test("--json and --fields coexist with other command flags", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    const command = buildCommand<
      { json: boolean; fields?: string[]; limit: number },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: { human: () => "unused" },
      parameters: {
        flags: {
          limit: {
            kind: "parsed",
            parse: numberParser,
            brief: "Limit",
            default: "10",
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(
        this: TestContext,
        flags: { json: boolean; fields?: string[]; limit: number }
      ) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(
      app,
      ["test", "--json", "--fields", "id", "--limit", "50", "--verbose"],
      ctx as TestContext
    );

    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.json).toBe(true);
    expect(receivedFlags!.fields).toEqual(["id"]);
    expect(receivedFlags!.limit).toBe(50);
    // --verbose is stripped (we injected it)
    expect(receivedFlags!.verbose).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildCommand return-based output integration
// ---------------------------------------------------------------------------

describe("buildCommand return-based output", () => {
  test("renders human output when func returns data", async () => {
    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: {
        human: (d: { name: string; role: string }) => `${d.name} (${d.role})`,
      },
      parameters: {},
      async *func(this: TestContext) {
        yield new CommandOutput({ name: "Alice", role: "admin" });
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test"], ctx as TestContext);

    expect(ctx.output.join("")).toContain("Alice (admin)");
  });

  test("renders JSON output when --json is passed", async () => {
    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: {
        human: (d: { name: string; role: string }) => `${d.name} (${d.role})`,
      },
      parameters: {},
      async *func(this: TestContext) {
        yield new CommandOutput({ name: "Alice", role: "admin" });
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--json"], ctx as TestContext);

    const jsonOutput = JSON.parse(ctx.output.join(""));
    expect(jsonOutput).toEqual({ name: "Alice", role: "admin" });
  });

  test("applies --fields filtering to JSON output", async () => {
    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: {
        human: (d: { id: number; name: string; role: string }) => `${d.name}`,
      },
      parameters: {},
      async *func(this: TestContext) {
        yield new CommandOutput({ id: 1, name: "Alice", role: "admin" });
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(
      app,
      ["test", "--json", "--fields", "id,name"],
      ctx as TestContext
    );

    const jsonOutput = JSON.parse(ctx.output.join(""));
    expect(jsonOutput).toEqual({ id: 1, name: "Alice" });
    expect(jsonOutput).not.toHaveProperty("role");
  });

  test("shows hint in human mode, suppresses in JSON mode", async () => {
    const makeCommand = () =>
      buildCommand<{ json: boolean; fields?: string[] }, [], TestContext>({
        auth: false,
        docs: { brief: "Test" },
        output: {
          human: (d: { value: number }) => `Value: ${d.value}`,
        },
        parameters: {},
        async *func(this: TestContext) {
          yield new CommandOutput({ value: 42 });
          return { hint: "Run 'sentry help' for more info" };
        },
      });

    // Human mode — hint should appear
    const routeMap1 = buildRouteMap({
      routes: { test: makeCommand() },
      docs: { brief: "Test app" },
    });
    const app1 = buildApplication(routeMap1, { name: "test" });
    const ctx1 = createTestContext();
    await run(app1, ["test"], ctx1 as TestContext);

    const humanOutput = ctx1.output.join("");
    expect(humanOutput).toContain("Value: 42");
    expect(humanOutput).toContain("Run 'sentry help' for more info");

    // JSON mode — hint should be suppressed
    const routeMap2 = buildRouteMap({
      routes: { test: makeCommand() },
      docs: { brief: "Test app" },
    });
    const app2 = buildApplication(routeMap2, { name: "test" });
    const ctx2 = createTestContext();
    await run(app2, ["test", "--json"], ctx2 as TestContext);

    const jsonRaw = ctx2.output.join("");
    expect(jsonRaw).not.toContain("Run 'sentry help' for more info");
    const jsonOutput = JSON.parse(jsonRaw);
    expect(jsonOutput).toEqual({ value: 42 });
  });

  test("void return does nothing (no crash)", async () => {
    let executed = false;

    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: {
        human: () => "unused",
      },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(this: TestContext) {
        executed = true;
        // Void return — simulates --web early exit
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test"], ctx as TestContext);

    expect(executed).toBe(true);
    // No output written — void return is silently ignored
    expect(ctx.output).toHaveLength(0);
  });

  test("data return is ignored without output config", async () => {
    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      // Deliberately no output config
      parameters: {},
      async *func(this: TestContext) {
        // This returns data, but without output config
        // the wrapper should NOT render it
        yield { value: 42 };
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test"], ctx as TestContext);

    // No output written — data return was silently ignored
    expect(ctx.output).toHaveLength(0);
  });

  test("works with async command functions", async () => {
    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: {
        human: (d: { name: string }) => `Hello, ${d.name}!`,
      },
      parameters: {},
      async *func(this: TestContext) {
        await sleep(1);
        yield new CommandOutput({ name: "Bob" });
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--json"], ctx as TestContext);

    const jsonOutput = JSON.parse(ctx.output.join(""));
    expect(jsonOutput).toEqual({ name: "Bob" });
  });

  test("array data works correctly via commandOutput wrapper", async () => {
    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: {
        human: (d: Array<{ id: number }>) => d.map(((x) => x.id).join(", ")),
      },
      parameters: {},
      async *func(this: TestContext) {
        yield new CommandOutput([{ id: 1 }, { id: 2 }]);
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--json"], ctx as TestContext);

    const jsonOutput = JSON.parse(ctx.output.join(""));
    expect(Array.isArray(jsonOutput)).toBe(true);
    expect(jsonOutput).toHaveLength(2);
    expect(jsonOutput[0]).toEqual({ id: 1 });
    expect(jsonOutput[1]).toEqual({ id: 2 });
  });

  test("hint shown in human mode only", async () => {
    const makeCommand = () =>
      buildCommand<{ json: boolean; fields?: string[] }, [], TestContext>({
        auth: false,
        docs: { brief: "Test" },
        output: {
          human: (d: { org: string }) => `Org: ${d.org}`,
        },
        parameters: {},
        async *func(this: TestContext) {
          yield new CommandOutput({ org: "sentry" });
          return { hint: "Detected from .env file" };
        },
      });

    const routeMap = buildRouteMap({
      routes: { test: makeCommand() },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });

    // Human mode
    const ctx1 = createTestContext();
    await run(app, ["test"], ctx1 as TestContext);
    const humanOutput = ctx1.output.join("");
    expect(humanOutput).toContain("Org: sentry");
    expect(humanOutput).toContain("Detected from .env file");

    // JSON mode
    const ctx2 = createTestContext();
    await run(app, ["test", "--json"], ctx2 as TestContext);
    const jsonRaw = ctx2.output.join("");
    expect(jsonRaw).not.toContain("Detected from");
    expect(JSON.parse(jsonRaw)).toEqual({ org: "sentry" });
  });

  test("OutputError renders data and exits with error code", async () => {
    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: {
        human: (d: { error: string }) => `Error: ${d.error}`,
      },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(this: TestContext) {
        throw new OutputError({ error: "not found" });
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    // Re-throw OutputError from Stricli's error handler (matches production app.ts)
    const app = buildApplication(routeMap, {
      name: "test",
      localization: {
        loadText: () => ({
          ...text_en,
          exceptionWhileRunningCommand: (exc: unknown) => {
            if (exc instanceof OutputError) throw exc;
            return text_en.exceptionWhileRunningCommand(exc, false);
          },
        }),
      },
    });
    const ctx = createTestContext();

    // OutputError is now thrown (not process.exit) — catch it
    try {
      await run(app, ["test"], ctx as TestContext);
      expect.unreachable("Expected OutputError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OutputError);
      expect((err as OutputError).exitCode).toBe(EXIT.OUTPUT_ERROR);
    }
    // Output was rendered BEFORE the throw
    expect(ctx.output.join("")).toContain("Error: not found");
  });

  test("OutputError renders JSON in --json mode", async () => {
    const command = buildCommand<
      { json: boolean; fields?: string[] },
      [],
      TestContext
    >({
      auth: false,
      docs: { brief: "Test" },
      output: {
        human: (d: { error: string }) => `Error: ${d.error}`,
      },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(this: TestContext) {
        throw new OutputError({ error: "not found" });
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    // Re-throw OutputError from Stricli's error handler (matches production app.ts)
    const app = buildApplication(routeMap, {
      name: "test",
      localization: {
        loadText: () => ({
          ...text_en,
          exceptionWhileRunningCommand: (exc: unknown) => {
            if (exc instanceof OutputError) throw exc;
            return text_en.exceptionWhileRunningCommand(exc, false);
          },
        }),
      },
    });
    const ctx = createTestContext();

    // OutputError is now thrown (not process.exit) — catch it
    try {
      await run(app, ["test", "--json"], ctx as TestContext);
      expect.unreachable("Expected OutputError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OutputError);
      expect((err as OutputError).exitCode).toBe(EXIT.OUTPUT_ERROR);
    }
    const jsonOutput = JSON.parse(ctx.output.join(""));
    expect(jsonOutput).toEqual({ error: "not found" });
  });
});

// ---------------------------------------------------------------------------
// applyOrgProjectFlags
// ---------------------------------------------------------------------------

describe("applyOrgProjectFlags", () => {
  let savedOrg: string | undefined;
  let savedProject: string | undefined;

  beforeEach(() => {
    savedOrg = process.env.SENTRY_ORG;
    savedProject = process.env.SENTRY_PROJECT;
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
  });

  afterEach(() => {
    if (savedOrg !== undefined) {
      process.env.SENTRY_ORG = savedOrg;
    } else {
      delete process.env.SENTRY_ORG;
    }
    if (savedProject !== undefined) {
      process.env.SENTRY_PROJECT = savedProject;
    } else {
      delete process.env.SENTRY_PROJECT;
    }
  });

  test("sets both env vars when flags provided", () => {
    applyOrgProjectFlags("my-org", "my-proj", false, false);
    expect(process.env.SENTRY_ORG).toBe("my-org");
    expect(process.env.SENTRY_PROJECT).toBe("my-proj");
  });

  test("skips when command owns the flag", () => {
    applyOrgProjectFlags("my-org", "my-proj", true, true);
    expect(process.env.SENTRY_ORG).toBeUndefined();
    expect(process.env.SENTRY_PROJECT).toBeUndefined();
  });

  test("sets only org when project is undefined", () => {
    applyOrgProjectFlags("my-org", undefined, false, false);
    expect(process.env.SENTRY_ORG).toBe("my-org");
    expect(process.env.SENTRY_PROJECT).toBeUndefined();
  });

  test("sets only project when org is undefined", () => {
    applyOrgProjectFlags(undefined, "my-proj", false, false);
    expect(process.env.SENTRY_ORG).toBeUndefined();
    expect(process.env.SENTRY_PROJECT).toBe("my-proj");
  });

  test("overwrites existing env var", () => {
    process.env.SENTRY_ORG = "old";
    applyOrgProjectFlags("new", undefined, false, false);
    expect(process.env.SENTRY_ORG).toBe("new");
  });

  test("does nothing when both flags are undefined", () => {
    applyOrgProjectFlags(undefined, undefined, false, false);
    expect(process.env.SENTRY_ORG).toBeUndefined();
    expect(process.env.SENTRY_PROJECT).toBeUndefined();
  });

  test("trims whitespace from flag values before writing", () => {
    applyOrgProjectFlags("  my-org  ", "  my-proj  ", false, false);
    expect(process.env.SENTRY_ORG).toBe("my-org");
    expect(process.env.SENTRY_PROJECT).toBe("my-proj");
  });

  test("treats empty string as not provided — preserves existing env var", () => {
    process.env.SENTRY_ORG = "preserved-org";
    applyOrgProjectFlags("", undefined, false, false);
    // Empty string must NOT clobber a real pre-existing env var
    expect(process.env.SENTRY_ORG).toBe("preserved-org");
  });

  test("treats whitespace-only as not provided — preserves existing env var", () => {
    process.env.SENTRY_PROJECT = "preserved-proj";
    applyOrgProjectFlags(undefined, "   ", false, false);
    // Whitespace-only must NOT clobber a real pre-existing env var
    expect(process.env.SENTRY_PROJECT).toBe("preserved-proj");
  });
});

// ---------------------------------------------------------------------------
// buildCommand --org/--project compat flags (end-to-end)
// ---------------------------------------------------------------------------

describe("buildCommand --org/--project compat flags", () => {
  let savedOrg: string | undefined;
  let savedProject: string | undefined;

  beforeEach(() => {
    savedOrg = process.env.SENTRY_ORG;
    savedProject = process.env.SENTRY_PROJECT;
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
  });

  afterEach(() => {
    if (savedOrg !== undefined) {
      process.env.SENTRY_ORG = savedOrg;
    } else {
      delete process.env.SENTRY_ORG;
    }
    if (savedProject !== undefined) {
      process.env.SENTRY_PROJECT = savedProject;
    } else {
      delete process.env.SENTRY_PROJECT;
    }
  });

  test("--org sets SENTRY_ORG env var", async () => {
    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      async *func() {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--org", "my-org"], ctx as TestContext);

    expect(process.env.SENTRY_ORG).toBe("my-org");
  });

  test("--project sets SENTRY_PROJECT env var", async () => {
    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      async *func() {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--project", "my-project"], ctx as TestContext);

    expect(process.env.SENTRY_PROJECT).toBe("my-project");
  });

  test("--org overwrites existing SENTRY_ORG", async () => {
    process.env.SENTRY_ORG = "original-org";

    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      async *func() {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--org", "new-org"], ctx as TestContext);

    expect(process.env.SENTRY_ORG).toBe("new-org");
  });

  test("--org and --project are stripped from func flags", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    const command = buildCommand<{ limit: number }, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          limit: {
            kind: "parsed",
            parse: numberParser,
            brief: "Limit",
            default: "10",
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command
      async *func(this: TestContext, flags: { limit: number }) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(
      app,
      ["test", "--org", "sentry", "--project", "cli", "--limit", "50"],
      ctx as TestContext
    );

    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.limit).toBe(50);
    expect(receivedFlags!.org).toBeUndefined();
    expect(receivedFlags!.project).toBeUndefined();
    // Both env vars set
    expect(process.env.SENTRY_ORG).toBe("sentry");
    expect(process.env.SENTRY_PROJECT).toBe("cli");
  });

  test("command-owned --project is preserved and NOT written to env", async () => {
    let receivedFlags: Record<string, unknown> | null = null;

    // Simulates release create which has its own --project flag
    const command = buildCommand<{ project?: string }, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {
        flags: {
          project: {
            kind: "parsed",
            parse: String,
            brief: "Project slug",
            optional: true,
          },
        },
      },
      // biome-ignore lint/correctness/useYield: test command
      async *func(this: TestContext, flags: { project?: string }) {
        receivedFlags = flags as unknown as Record<string, unknown>;
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--project", "my-project"], ctx as TestContext);

    // Command's own --project is passed through (not stripped)
    expect(receivedFlags).toBeDefined();
    expect(receivedFlags!.project).toBe("my-project");
    // Should NOT be written to env (command owns the flag)
    expect(process.env.SENTRY_PROJECT).toBeUndefined();
  });

  test("--org=value equals form works", async () => {
    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      async *func() {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--org=my-org"], ctx as TestContext);

    expect(process.env.SENTRY_ORG).toBe("my-org");
  });

  test("--project overwrites existing SENTRY_PROJECT", async () => {
    process.env.SENTRY_PROJECT = "original-proj";

    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      async *func() {
        // no-op
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(app, ["test", "--project", "new-proj"], ctx as TestContext);

    expect(process.env.SENTRY_PROJECT).toBe("new-proj");
  });

  test("--org/--project values flow into resolveOrgAndProject (end-to-end)", async () => {
    // Integration test: verifies the full plumbing from CLI flag → env var
    // → resolveFromEnvVars (priority #2 in the resolution chain). This is the
    // contract this PR exists to deliver: LLM-generated `--org foo --project
    // bar` should make org/project resolution succeed without an explicit
    // positional arg.
    let resolved: Awaited<ReturnType<typeof resolveOrgAndProject>> = null;

    const command = buildCommand<Record<string, never>, [], TestContext>({
      auth: false,
      docs: { brief: "Test" },
      parameters: {},
      // biome-ignore lint/correctness/useYield: test command — no output to yield
      async *func(this: TestContext) {
        resolved = await resolveOrgAndProject({ cwd: "/tmp" });
      },
    });

    const routeMap = buildRouteMap({
      routes: { test: command },
      docs: { brief: "Test app" },
    });
    const app = buildApplication(routeMap, { name: "test" });
    const ctx = createTestContext();

    await run(
      app,
      ["test", "--org", "flag-org", "--project", "flag-proj"],
      ctx as TestContext
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.org).toBe("flag-org");
    expect(resolved?.project).toBe("flag-proj");
    // detectedFrom proves the resolution went through the env-var path,
    // not some other branch.
    expect(resolved?.detectedFrom).toContain("env var");
  });
});
