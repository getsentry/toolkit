import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import {
  createLogger,
  formatLocalTime,
  LOG_LEVEL_NAMES,
  type LogObject,
  parseLogLevel,
} from "../src/index.js";
import { clackPrompt } from "../src/prompt.js";

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

  test("is case-insensitive and trims whitespace", () => {
    expect(parseLogLevel("ERROR")).toBe(0);
    expect(parseLogLevel("Debug")).toBe(4);
    expect(parseLogLevel("\ttrace\n")).toBe(5);
  });

  test("returns default (info=3) for unrecognized values", () => {
    expect(parseLogLevel("verbose")).toBe(3);
    expect(parseLogLevel("")).toBe(3);
    expect(parseLogLevel("42")).toBe(3);
  });
});

describe("LOG_LEVEL_NAMES", () => {
  test("index is the numeric level", () => {
    expect(LOG_LEVEL_NAMES).toEqual([
      "error",
      "warn",
      "log",
      "info",
      "debug",
      "trace",
    ]);
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
    expect(formatLocalTime(new Date("2024-01-15T14:28:59.000Z"))).toBe(
      "06:28:59",
    );
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

describe("levels and reporters", () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  test("scoped loggers share the root's level, including ones created earlier", () => {
    const logger = createLogger();
    const child = logger.withTag("parent");
    const grandchild = child.withTag("sub");
    expect(grandchild.level).toBe(3);

    logger.level = 5;
    expect(child.level).toBe(5);
    expect(grandchild.level).toBe(5);

    grandchild.level = 0;
    expect(logger.level).toBe(0);
  });

  test("separate root loggers do not share state", () => {
    const first = createLogger({ level: 0 });
    const second = createLogger();
    first.level = 5;
    expect(second.level).toBe(3);
  });

  test("reporters receive consola-shaped records that Sentry's reporter reads", () => {
    const records: LogObject[] = [];
    const logger = createLogger();
    // The reporter list is shared, so a reporter added through the root
    // logger also sees records from scoped loggers.
    const scoped = logger.withTag("upgrade").withTag("delta");
    logger.addReporter({ log: (logObj) => records.push(logObj) });

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

  test("methods stay bound when passed around", () => {
    const records: LogObject[] = [];
    const logger = createLogger();
    logger.addReporter({ log: (logObj) => records.push(logObj) });
    const { info } = logger.withTag("detached");
    info("hello");
    expect(records).toMatchObject([{ type: "info", tag: "detached" }]);
  });
});

describe("stderr output", () => {
  let stderr: MockInstance<typeof process.stderr.write>;

  /** Text written to stderr so far. */
  const written = () =>
    stderr.mock.calls.map((call) => String(call[0])).join("");

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  test("writes plain [type] [tag] lines in CI", () => {
    const logger = createLogger({ env: () => ({ CI: "true" }) });
    logger.withTag("auth").info("Logged in as %s", "jane");
    expect(written()).toBe("[info] [auth] Logged in as jane\n");
  });

  test("reads the env on each call", () => {
    let env: Record<string, string> = { CI: "true" };
    const logger = createLogger({ env: () => env });
    logger.info("plain");
    env = { NO_COLOR: "1" };
    logger.info("fancy");
    expect(written()).toBe("[info] plain\nℹ fancy\n");
  });

  test("writes an error's message, stack, and cause but not its other properties", () => {
    const logger = createLogger({ env: () => ({ CI: "true" }) });
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
    const logger = createLogger({
      env: () => ({ NODE_ENV: "production", NO_COLOR: "1" }),
    });

    logger.withTag("auth").success("Run `sentry auth status`");
    logger.warn("Token expires soon");

    // Non-TTY stderr has no columns, so the tag leads the line.
    expect(written()).toBe(
      "[auth] ✔ Run sentry auth status\n\n WARN  Token expires soon\n\n",
    );
  });

  test("right-aligns the tag and the formatted time on wide terminals", () => {
    const columns = Object.getOwnPropertyDescriptor(process.stderr, "columns");
    Object.defineProperty(process.stderr, "columns", {
      value: 80,
      configurable: true,
    });
    try {
      const logger = createLogger({
        env: () => ({ NO_COLOR: "1" }),
        formatTime: () => "T",
      });
      logger.withTag("auth").info("hi");
      const line = written();
      expect(line).toBe(`ℹ hi${" ".repeat(68)}auth T\n`);
    } finally {
      if (columns) {
        Object.defineProperty(process.stderr, "columns", columns);
      } else {
        delete (process.stderr as { columns?: number }).columns;
      }
    }
  });
});

describe("prompt", () => {
  test("rejects when no prompt is configured", async () => {
    await expect(
      createLogger().prompt("Continue?", { type: "confirm" }),
    ).rejects.toThrow("No prompt is configured");
  });

  test("scoped loggers use the root's prompt", async () => {
    const prompt = vi.fn().mockResolvedValue("answer");
    const logger = createLogger({ prompt });
    await expect(
      logger.withTag("x").prompt("Name?", { type: "text" }),
    ).resolves.toBe("answer");
    expect(prompt).toHaveBeenCalledWith("Name?", { type: "text" });
  });

  test("clackPrompt returns clack's cancel symbol instead of the initial value", async () => {
    const cancel = Symbol("clack:cancel");
    clack.confirm.mockResolvedValue(cancel);

    const answer = await clackPrompt("Import from .sentryclirc?", {
      type: "confirm",
      initial: true,
    });

    expect(clack.confirm).toHaveBeenCalledWith({
      message: "Import from .sentryclirc?",
      initialValue: true,
    });
    expect(answer).toBe(cancel);
  });

  test("clackPrompt passes text prompt options through to clack", async () => {
    clack.text.mockResolvedValue("my-project");

    const answer = await clackPrompt("Type the project slug:", {
      type: "text",
      placeholder: "slug",
      default: "fallback",
    });

    expect(clack.text).toHaveBeenCalledWith({
      message: "Type the project slug:",
      placeholder: "slug",
      initialValue: undefined,
      defaultValue: "fallback",
    });
    expect(answer).toBe("my-project");
  });
});
