/**
 * Unit tests for the logger module.
 *
 * Tests parseLogLevel, getEnvLogLevel, setLogLevel (with withTag propagation),
 * attachSentryReporter, and the logger instance configuration.
 */

import { createConsolaReporter } from "@sentry/node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  attachSentryReporter,
  getEnvLogLevel,
  LOG_LEVEL_ENV_VAR,
  LOG_LEVEL_NAMES,
  type LogObject,
  logger,
  parseLogLevel,
  printLine,
  setLogLevel,
} from "../../src/lib/logger.js";

const clack = vi.hoisted(() => ({
  confirm: vi.fn(),
  text: vi.fn(),
}));

vi.mock("@clack/prompts", () => clack);

describe("parseLogLevel", () => {
  test("maps known level names to correct numeric values", () => {
    expect(parseLogLevel("error")).toBe(0);
    expect(parseLogLevel("warn")).toBe(1);
    expect(parseLogLevel("log")).toBe(2);
    expect(parseLogLevel("info")).toBe(3);
    expect(parseLogLevel("debug")).toBe(4);
    expect(parseLogLevel("trace")).toBe(5);
  });

  test("is case-insensitive", () => {
    expect(parseLogLevel("ERROR")).toBe(0);
    expect(parseLogLevel("Debug")).toBe(4);
    expect(parseLogLevel("TRACE")).toBe(5);
    expect(parseLogLevel("Warn")).toBe(1);
  });

  test("trims whitespace", () => {
    expect(parseLogLevel("  debug  ")).toBe(4);
    expect(parseLogLevel("\ttrace\n")).toBe(5);
  });

  test("returns default (info=3) for unrecognized values", () => {
    expect(parseLogLevel("verbose")).toBe(3);
    expect(parseLogLevel("")).toBe(3);
    expect(parseLogLevel("unknown")).toBe(3);
    expect(parseLogLevel("42")).toBe(3);
  });
});

describe("LOG_LEVEL_NAMES", () => {
  test("contains all expected level names with index = numeric level", () => {
    expect(LOG_LEVEL_NAMES).toEqual([
      "error", // 0
      "warn", // 1
      "log", // 2
      "info", // 3
      "debug", // 4
      "trace", // 5
    ]);
  });

  test("all names are valid for parseLogLevel", () => {
    for (const name of LOG_LEVEL_NAMES) {
      const level = parseLogLevel(name);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(5);
    }
  });
});

describe("LOG_LEVEL_ENV_VAR", () => {
  test("is SENTRY_LOG_LEVEL", () => {
    expect(LOG_LEVEL_ENV_VAR).toBe("SENTRY_LOG_LEVEL");
  });
});

describe("getEnvLogLevel", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[LOG_LEVEL_ENV_VAR];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[LOG_LEVEL_ENV_VAR];
    } else {
      process.env[LOG_LEVEL_ENV_VAR] = savedEnv;
    }
  });

  test("returns null when env var is not set", () => {
    delete process.env[LOG_LEVEL_ENV_VAR];
    expect(getEnvLogLevel()).toBeNull();
  });

  test("returns parsed level when env var is set", () => {
    process.env[LOG_LEVEL_ENV_VAR] = "debug";
    expect(getEnvLogLevel()).toBe(4);
  });

  test("returns parsed level for each valid name", () => {
    for (const [idx, name] of LOG_LEVEL_NAMES.entries()) {
      process.env[LOG_LEVEL_ENV_VAR] = name;
      expect(getEnvLogLevel()).toBe(idx);
    }
  });

  test("returns null for empty string", () => {
    process.env[LOG_LEVEL_ENV_VAR] = "";
    expect(getEnvLogLevel()).toBeNull();
  });
});

describe("setLogLevel", () => {
  let originalLevel: number;

  beforeEach(() => {
    originalLevel = logger.level;
  });

  afterEach(() => {
    logger.level = originalLevel;
  });

  test("changes the logger level", () => {
    setLogLevel(4);
    expect(logger.level).toBe(4);
  });

  test("can set to error level", () => {
    setLogLevel(0);
    expect(logger.level).toBe(0);
  });

  test("can set to trace level", () => {
    setLogLevel(5);
    expect(logger.level).toBe(5);
  });

  test("propagates level to withTag children", () => {
    const child1 = logger.withTag("test-child-1");
    const child2 = logger.withTag("test-child-2");

    // Children start at the logger's current level
    expect(child1.level).toBe(logger.level);
    expect(child2.level).toBe(logger.level);

    // Change the level
    setLogLevel(5);
    expect(child1.level).toBe(5);
    expect(child2.level).toBe(5);

    // Change again
    setLogLevel(0);
    expect(child1.level).toBe(0);
    expect(child2.level).toBe(0);
  });

  test("propagates to children created before level change", () => {
    // Simulate the real-world scenario: module-level child created at default level,
    // then setLogLevel called later by cli.ts
    const moduleChild = logger.withTag("upgrade");
    expect(moduleChild.level).toBe(originalLevel);

    setLogLevel(4); // debug
    expect(moduleChild.level).toBe(4);
  });

  test("propagates to grandchildren (nested withTag)", () => {
    const child = logger.withTag("parent");
    const grandchild = child.withTag("sub-scope");

    expect(grandchild.level).toBe(logger.level);

    setLogLevel(5); // trace
    expect(child.level).toBe(5);
    expect(grandchild.level).toBe(5);

    setLogLevel(0); // error
    expect(child.level).toBe(0);
    expect(grandchild.level).toBe(0);
  });
});

describe("logger instance", () => {
  test("exposes the log methods", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.trace).toBe("function");
    expect(typeof logger.success).toBe("function");
    expect(typeof logger.withTag).toBe("function");
  });

  test("withTag returns a scoped logger", () => {
    const scoped = logger.withTag("test-scope");
    expect(typeof scoped.info).toBe("function");
    expect(typeof scoped.debug).toBe("function");
  });

  test("level can be set to info (3) via setLogLevel", () => {
    const before = logger.level;
    try {
      setLogLevel(3);
      expect(logger.level).toBe(3);
    } finally {
      setLogLevel(before);
    }
  });
});

/** Matches an `HH:MM:SS` clock time anywhere in a rendered log line. */
const TIME_RE = /\d{2}:\d{2}:\d{2}/g;

describe("printLine", () => {
  test("writes the line verbatim to stderr with a trailing newline", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      printLine("12:34:56 [INFO]    [SERVER]  Hello");
      expect(spy).toHaveBeenCalledWith("12:34:56 [INFO]    [SERVER]  Hello\n");
    } finally {
      spy.mockRestore();
    }
  });

  test("does not add a second timestamp the way logger.log does", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      printLine("12:34:56 [INFO]    [SERVER]  Hello");
      const written = spy.mock.calls.map((call) => String(call[0])).join("");
      expect(written.match(TIME_RE)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("printJsonLine", () => {
  test("writes an NDJSON record only to stdout", async () => {
    const loggerModule =
      (await import("../../src/lib/logger.js")) as typeof import("../../src/lib/logger.js") & {
        printJsonLine?: (line: string) => void;
      };
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(loggerModule.printJsonLine).toBeTypeOf("function");
      loggerModule.printJsonLine?.('{"schema_version":1,"type":"error"}');
      expect(stdout).toHaveBeenCalledWith(
        '{"schema_version":1,"type":"error"}\n',
      );
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe("attachSentryReporter", () => {
  test("can be called without error", () => {
    // attachSentryReporter is idempotent and safe to call even when
    // Sentry is not initialized (it catches errors internally)
    expect(() => attachSentryReporter(createConsolaReporter())).not.toThrow();
  });

  test("is idempotent (second call is a no-op)", () => {
    // First call may or may not succeed depending on Sentry state
    attachSentryReporter(createConsolaReporter());
    // Second call should be a no-op due to internal guard
    expect(() => attachSentryReporter(createConsolaReporter())).not.toThrow();
  });
});

describe("reporters", () => {
  let originalLevel: number;
  let records: LogObject[];
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalLevel = logger.level;
    records = [];
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    setLogLevel(originalLevel);
    stderr.mockRestore();
  });

  test("receive consola-shaped records that Sentry's reporter reads", () => {
    // The level and reporter list are shared, so a reporter added through the
    // root logger also sees records from scoped loggers.
    logger.addReporter({ log: (logObj) => records.push(logObj) });
    const scoped = logger.withTag("upgrade").withTag("delta");
    setLogLevel(3);

    scoped.warn("Patch %s failed", "0.13.0");
    scoped.debug("dropped above the level");

    expect(records).toEqual([
      {
        date: expect.any(Date),
        args: ["Patch %s failed", "0.13.0"],
        type: "warn",
        level: 1,
        tag: "upgrade:delta",
      },
    ]);
  });
});

describe("stderr output", () => {
  const ENV_KEYS = ["CI", "TEST", "NODE_ENV", "NO_COLOR", "FORCE_COLOR"];
  let savedEnv: Record<string, string | undefined>;
  let stderr: ReturnType<typeof vi.spyOn>;

  /** Text written to stderr so far. */
  const written = () =>
    stderr.mock.calls.map((call) => String(call[0])).join("");

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    stderr.mockRestore();
  });

  test("writes plain [type] [tag] lines in tests and CI", () => {
    process.env.CI = "true";
    logger.withTag("auth").info("Logged in as %s", "jane");
    expect(written()).toBe("[info] [auth] Logged in as jane\n");
  });

  test("writes an error's message, stack, and cause but not its other properties", () => {
    process.env.CI = "true";
    const error = Object.assign(
      new Error("Request failed", { cause: new Error("socket hang up") }),
      { response: { headers: { authorization: "Bearer secret" } } },
    );

    logger.warn("Upload failed:", error);

    const output = written();
    expect(output).toMatch(/^\[warn\] Upload failed: Request failed\n {2}at /);
    expect(output).toContain("\n\n  [cause]: socket hang up\n    at ");
    expect(output).not.toContain("secret");
  });

  test("writes icons, badges, and inline code in the interactive layout", () => {
    for (const key of ["CI", "TEST"]) {
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    process.env.NO_COLOR = "1";

    logger.withTag("auth").success("Run `sentry auth status`");
    logger.warn("Token expires soon");

    // Non-TTY stderr has no columns, so the tag leads the line.
    expect(written()).toBe(
      "[auth] ✔ Run sentry auth status\n\n WARN  Token expires soon\n\n",
    );
  });
});

describe("prompt", () => {
  test("returns clack's cancel symbol instead of the initial value on Ctrl+C", async () => {
    const cancel = Symbol("clack:cancel");
    clack.confirm.mockResolvedValue(cancel);

    const answer = await logger.prompt("Import from .sentryclirc?", {
      type: "confirm",
      initial: true,
    });

    expect(clack.confirm).toHaveBeenCalledWith({
      message: "Import from .sentryclirc?",
      initialValue: true,
    });
    expect(answer).toBe(cancel);
  });

  test("passes text prompt options through to clack", async () => {
    clack.text.mockResolvedValue("my-project");

    const answer = await logger
      .withTag("delete")
      .prompt("Type the project slug:", { type: "text", placeholder: "slug" });

    expect(clack.text).toHaveBeenCalledWith({
      message: "Type the project slug:",
      placeholder: "slug",
      initialValue: undefined,
      defaultValue: undefined,
    });
    expect(answer).toBe("my-project");
  });
});
