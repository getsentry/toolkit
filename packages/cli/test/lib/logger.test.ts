/**
 * Unit tests for the CLI's logger configuration.
 *
 * Tests getEnvLogLevel, setLogLevel (with withTag propagation),
 * attachSentryReporter, and the library-mode env. The logger itself is tested
 * in packages/logger.
 */

import { sentryReporter } from "@sentry/logger";
import { logger as sentryLogger } from "@sentry/node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withEnv } from "../../src/lib/env.js";
import {
  attachSentryReporter,
  getEnvLogLevel,
  LOG_LEVEL_ENV_VAR,
  LOG_LEVEL_NAMES,
  logger,
  printLine,
  setLogLevel,
} from "../../src/lib/logger.js";

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
    expect(() =>
      attachSentryReporter(sentryReporter(sentryLogger)),
    ).not.toThrow();
  });

  test("is idempotent (second call is a no-op)", () => {
    // First call may or may not succeed depending on Sentry state
    attachSentryReporter(sentryReporter(sentryLogger));
    // Second call should be a no-op due to internal guard
    expect(() =>
      attachSentryReporter(sentryReporter(sentryLogger)),
    ).not.toThrow();
  });
});

describe("stderr output", () => {
  test("reads the library-mode env instead of process.env", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      withEnv({ NODE_ENV: "production", NO_COLOR: "1" }, () => {
        logger.withTag("auth").success("Run `sentry auth status`");
      });
      withEnv({ CI: "true" }, () => {
        logger.withTag("auth").info("Logged in");
      });
      expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual([
        "[auth] ✔ Run sentry auth status\n",
        "[info] [auth] Logged in\n",
      ]);
    } finally {
      stderr.mockRestore();
    }
  });
});
