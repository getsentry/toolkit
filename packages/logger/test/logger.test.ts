import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import {
  createLogger,
  fancyReporter,
  formatLocalTime,
  jsonReporter,
  LOG_LEVEL_NAMES,
  type LogRecord,
  logfmtReporter,
  parseLogLevel,
  type SentryLogger,
  sentryReporter,
} from "../src/index.js";

/** A stream that keeps what reporters write to it. */
function memoryStream(options: { columns?: number } = {}) {
  const chunks: string[] = [];
  return {
    chunks,
    text: () => chunks.join(""),
    write: (chunk: string) => chunks.push(chunk),
    ...options,
  };
}

/** A logger that only records what it would report. */
function recordingLogger() {
  const records: LogRecord[] = [];
  const logger = createLogger({
    reporters: [{ log: (record) => records.push(record) }],
  });
  return { logger, records };
}

const DATE = new Date("2024-01-15T14:28:59.000Z");

describe("parseLogLevel", () => {
  test("maps known level names to correct numeric values", () => {
    expect(LOG_LEVEL_NAMES.map(parseLogLevel)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(parseLogLevel("ERROR")).toBe(0);
    expect(parseLogLevel("\tTrace\n")).toBe(5);
  });

  test("returns default (info=3) for unrecognized values", () => {
    expect(parseLogLevel("verbose")).toBe(3);
    expect(parseLogLevel("")).toBe(3);
  });
});

describe("logger", () => {
  test("records carry the tag, attributes, type, level, and arguments", () => {
    const { logger, records } = recordingLogger();
    const scoped = logger
      .withTag("upgrade")
      .withAttributes({ org: "acme", attempt: 1 })
      .withTag("delta")
      .withAttributes({ attempt: 2 });

    scoped.warn("Patch %s failed", "0.13.0");
    scoped.debug("dropped above the level");

    expect(records).toEqual([
      {
        date: expect.any(Date),
        args: ["Patch %s failed", "0.13.0"],
        type: "warn",
        level: 1,
        tag: "upgrade:delta",
        attributes: { org: "acme", attempt: 2 },
      },
    ]);
  });

  test("scoped loggers share the root's level, including ones created earlier", () => {
    const { logger } = recordingLogger();
    const child = logger.withTag("parent").withAttributes({ a: 1 });
    logger.level = 5;
    expect(child.level).toBe(5);
    child.level = 0;
    expect(logger.level).toBe(0);
  });

  test("a reporter added later sees records from every related logger", () => {
    const { logger } = recordingLogger();
    const child = logger.withTag("child");
    const late: LogRecord[] = [];
    logger.addReporter({ log: (record) => late.push(record) });
    child.info("hi");
    expect(late).toMatchObject([{ tag: "child" }]);
  });

  test("separate root loggers do not share state", () => {
    const first = createLogger({ level: 0, reporters: [] });
    const second = createLogger({ reporters: [] });
    first.level = 5;
    expect(second.level).toBe(3);
  });

  test("methods stay bound when passed around", () => {
    const { logger, records } = recordingLogger();
    const { info } = logger.withTag("detached");
    info("hello");
    expect(records).toMatchObject([{ type: "info", tag: "detached" }]);
  });

  describe("default reporter", () => {
    let stderr: MockInstance;
    let savedCi: string | undefined;

    beforeEach(() => {
      savedCi = process.env.CI;
      process.env.CI = "true";
      stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    afterEach(() => {
      stderr.mockRestore();
      if (savedCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = savedCi;
      }
    });

    test("is the fancy reporter on stderr", () => {
      createLogger().withTag("auth").info("Logged in");
      expect(stderr).toHaveBeenCalledWith("[info] [auth] Logged in\n");
    });
  });
});

describe("formatLocalTime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders 24-hour HH:MM:SS in local time", () => {
    // Force a +480 (US/Pacific standard, UTC-8) offset so the local wall-clock
    // is 06:28:59 regardless of the host machine's zone.
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(480);
    expect(formatLocalTime(DATE)).toBe("06:28:59");
  });

  test("east-of-UTC (negative offset) wraps past midnight", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-60);
    expect(formatLocalTime(new Date("2024-01-15T23:30:00.000Z"))).toBe(
      "00:30:00",
    );
  });

  test("zero-pads single-digit components", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
    expect(formatLocalTime(new Date("2024-01-15T01:02:03.000Z"))).toBe(
      "01:02:03",
    );
  });
});

describe("fancyReporter", () => {
  function fancyLogger(
    env: Record<string, string>,
    options: { columns?: number; formatTime?: (date: Date) => string } = {},
  ) {
    const stream = memoryStream({ columns: options.columns });
    const logger = createLogger({
      reporters: [
        fancyReporter({
          stream,
          env: () => env,
          formatTime: options.formatTime,
        }),
      ],
    });
    return { logger, stream };
  }

  test("writes plain [type] [tag] lines in CI", () => {
    const { logger, stream } = fancyLogger({ CI: "true" });
    logger.withTag("auth").info("Logged in as %s", "jane");
    expect(stream.text()).toBe("[info] [auth] Logged in as jane\n");
  });

  test("reads the env on each call", () => {
    let env: Record<string, string> = { CI: "true" };
    const stream = memoryStream();
    const logger = createLogger({
      reporters: [fancyReporter({ stream, env: () => env })],
    });
    logger.info("plain");
    env = { NO_COLOR: "1" };
    logger.info("fancy");
    expect(stream.text()).toBe("[info] plain\nℹ fancy\n");
  });

  test("writes an error's message, stack, and cause but not its other properties", () => {
    const { logger, stream } = fancyLogger({ CI: "true" });
    const error = Object.assign(
      new Error("Request failed", { cause: new Error("socket hang up") }),
      { response: { headers: { authorization: "Bearer secret" } } },
    );

    logger.warn("Upload failed:", error);

    expect(stream.text()).toMatch(
      /^\[warn\] Upload failed: Request failed\n {2}at /,
    );
    expect(stream.text()).toContain("\n\n  [cause]: socket hang up\n    at ");
    expect(stream.text()).not.toContain("secret");
  });

  test("writes icons, badges, and inline code in the interactive layout", () => {
    const { logger, stream } = fancyLogger({
      NODE_ENV: "production",
      NO_COLOR: "1",
    });

    logger.withTag("auth").success("Run `sentry auth status`");
    logger.warn("Token expires soon");

    // A stream without columns puts the tag first.
    expect(stream.text()).toBe(
      "[auth] ✔ Run sentry auth status\n\n WARN  Token expires soon\n\n",
    );
  });

  test("right-aligns the tag and the formatted time on wide terminals", () => {
    const { logger, stream } = fancyLogger(
      { NO_COLOR: "1" },
      { columns: 80, formatTime: () => "T" },
    );
    logger.withTag("auth").info("hi");
    expect(stream.text()).toBe(`ℹ hi${" ".repeat(68)}auth T\n`);
  });
});

describe("jsonReporter", () => {
  test("writes one JSON object per call, built-in fields first", () => {
    const stream = memoryStream();
    const reporter = jsonReporter({ stream });
    reporter.log({
      date: DATE,
      args: ["Uploaded %d files", 3],
      type: "success",
      level: 3,
      tag: "upload",
      attributes: { org: "acme", msg: "ignored" },
    });
    reporter.log({
      date: DATE,
      args: ["no tag"],
      type: "info",
      level: 3,
      tag: "",
      attributes: {},
    });

    expect(stream.chunks).toEqual([
      '{"time":"2024-01-15T14:28:59.000Z","level":"info","type":"success","tag":"upload","msg":"Uploaded 3 files","org":"acme"}\n',
      '{"time":"2024-01-15T14:28:59.000Z","level":"info","msg":"no tag"}\n',
    ]);
  });
});

describe("logfmtReporter", () => {
  test("writes key=value pairs, quoting and escaping where needed", () => {
    const stream = memoryStream();
    logfmtReporter({ stream }).log({
      date: DATE,
      args: ['Said "hi"\nthen left'],
      type: "warn",
      level: 1,
      tag: "chat",
      attributes: { user: "jane doe", count: 2, ok: true, "bad key": "x=y" },
    });

    expect(stream.text()).toBe(
      'time=2024-01-15T14:28:59.000Z level=warn tag=chat msg="Said \\"hi\\"\\nthen left" user="jane doe" count=2 ok=true bad_key="x=y"\n',
    );
  });
});

describe("sentryReporter", () => {
  function fakeSentryLogger() {
    const calls: [string, string, Record<string, unknown> | undefined][] = [];
    const method =
      (severity: string) =>
      (message: string, attributes?: Record<string, unknown>) =>
        calls.push([severity, message, attributes]);
    const sentryLogger: SentryLogger = {
      trace: method("trace"),
      debug: method("debug"),
      info: method("info"),
      warn: method("warn"),
      error: method("error"),
    };
    return { calls, sentryLogger };
  }

  test("forwards each call at its severity with its attributes", () => {
    const { calls, sentryLogger } = fakeSentryLogger();
    const logger = createLogger({
      level: 5,
      reporters: [sentryReporter(sentryLogger)],
    });
    const scoped = logger.withTag("auth").withAttributes({ org: "acme" });

    scoped.success("Logged in as %s", "jane");
    scoped.fail("Nope");
    logger.trace("deep");

    expect(calls).toEqual([
      [
        "info",
        "Logged in as jane",
        {
          org: "acme",
          "logger.tag": "auth",
          "logger.type": "success",
          "sentry.origin": "auto.log.sentry_logger",
        },
      ],
      ["error", "Nope", expect.objectContaining({ "logger.type": "fail" })],
      [
        "trace",
        "deep",
        { "logger.type": "trace", "sentry.origin": "auto.log.sentry_logger" },
      ],
    ]);
  });

  test("sends an error's message and cause without its stack", () => {
    const { calls, sentryLogger } = fakeSentryLogger();
    createLogger({ reporters: [sentryReporter(sentryLogger)] }).error(
      "Upload failed:",
      new Error("Request failed", { cause: new Error("socket hang up") }),
    );
    expect(calls[0]?.[1]).toBe(
      "Upload failed: Request failed [cause]: socket hang up",
    );
  });
});
