/**
 * Tests for the clack-plain adapter.
 *
 * Verifies that clack output functions produce clean plain text when
 * isPlainOutput() is true, and delegate to real @clack/prompts when false.
 */

// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as clack from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  select,
} from "../../../src/lib/init/clack-plain.js";

let savedPlainOutput: string | undefined;
let stdoutSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  savedPlainOutput = process.env.SENTRY_PLAIN_OUTPUT;
  stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  if (savedPlainOutput === undefined) {
    delete process.env.SENTRY_PLAIN_OUTPUT;
  } else {
    process.env.SENTRY_PLAIN_OUTPUT = savedPlainOutput;
  }
});

describe("plain mode (SENTRY_PLAIN_OUTPUT=1)", () => {
  beforeEach(() => {
    process.env.SENTRY_PLAIN_OUTPUT = "1";
  });

  test("intro writes clean text", () => {
    intro("sentry init");

    expect(stdoutSpy).toHaveBeenCalledWith("sentry init\n");
  });

  test("intro does nothing when no title", () => {
    intro();

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test("outro writes clean text", () => {
    outro("Done!");

    expect(stdoutSpy).toHaveBeenCalledWith("Done!\n");
  });

  test("cancel writes clean text", () => {
    cancel("Setup cancelled.");

    expect(stdoutSpy).toHaveBeenCalledWith("Setup cancelled.\n");
  });

  test("log.info writes clean text", () => {
    log.info("Hello world");

    expect(stdoutSpy).toHaveBeenCalledWith("Hello world\n");
  });

  test("log.warn prefixes with warning symbol", () => {
    log.warn("Watch out");

    expect(stdoutSpy).toHaveBeenCalledWith("⚠ Watch out\n");
  });

  test("log.error prefixes with error symbol", () => {
    log.error("Something broke");

    expect(stdoutSpy).toHaveBeenCalledWith("✗ Something broke\n");
  });

  test("log.success prefixes with success symbol", () => {
    log.success("All good");

    expect(stdoutSpy).toHaveBeenCalledWith("✓ All good\n");
  });

  test("log.message writes clean text", () => {
    log.message("Just a message");

    expect(stdoutSpy).toHaveBeenCalledWith("Just a message\n");
  });

  test("log.step writes clean text", () => {
    log.step("Step 1");

    expect(stdoutSpy).toHaveBeenCalledWith("Step 1\n");
  });

  test("log.info strips ANSI escape sequences", () => {
    const ansiText = "\x1b[32mGreen\x1b[0m text";
    log.info(ansiText);

    expect(stdoutSpy).toHaveBeenCalledWith("Green text\n");
  });
});

describe("rich mode (SENTRY_PLAIN_OUTPUT=0)", () => {
  let introSpy: ReturnType<typeof spyOn>;
  let outroSpy: ReturnType<typeof spyOn>;
  let cancelSpy: ReturnType<typeof spyOn>;
  let logInfoSpy: ReturnType<typeof spyOn>;

  const noop = () => {
    /* suppress clack output */
  };

  beforeEach(() => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    introSpy = vi.spyOn(clack, "intro").mockImplementation(noop);
    outroSpy = vi.spyOn(clack, "outro").mockImplementation(noop);
    cancelSpy = vi.spyOn(clack, "cancel").mockImplementation(noop);
    logInfoSpy = vi.spyOn(clack.log, "info").mockImplementation(noop);
  });

  afterEach(() => {
    introSpy.mockRestore();
    outroSpy.mockRestore();
    cancelSpy.mockRestore();
    logInfoSpy.mockRestore();
  });

  test("intro delegates to clack", () => {
    intro("sentry init");

    expect(introSpy).toHaveBeenCalledWith("sentry init");
  });

  test("outro delegates to clack", () => {
    outro("Done!");

    expect(outroSpy).toHaveBeenCalledWith("Done!");
  });

  test("cancel delegates to clack", () => {
    cancel("Setup cancelled.");

    expect(cancelSpy).toHaveBeenCalledWith("Setup cancelled.");
  });

  test("log.info delegates to clack", () => {
    log.info("Hello");

    expect(logInfoSpy).toHaveBeenCalledWith("Hello");
  });
});

describe("pass-through functions", () => {
  test("isCancel delegates to real clack.isCancel", () => {
    // clack uses a module-private symbol, so we can only test non-cancel values
    expect(isCancel("not-cancel")).toBe(false);
    expect(isCancel(42)).toBe(false);
    expect(isCancel(null)).toBe(false);
  });

  test("select delegates to clack.select", () => {
    const selectSpy = vi.spyOn(clack, "select").mockResolvedValue("choice");

    const result = select({
      message: "Pick one",
      options: [{ value: "choice", label: "Choice" }],
    });

    expect(selectSpy).toHaveBeenCalled();
    selectSpy.mockRestore();
    return result;
  });

  test("confirm delegates to clack.confirm", () => {
    const confirmSpy = vi.spyOn(clack, "confirm").mockResolvedValue(true);

    const result = confirm({ message: "Continue?" });

    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
    return result;
  });

  test("multiselect delegates to clack.multiselect", () => {
    const multiselectSpy = vi.spyOn(clack, "multiselect").mockResolvedValue([]);

    const result = multiselect({
      message: "Pick some",
      options: [{ value: "a", label: "A" }],
    });

    expect(multiselectSpy).toHaveBeenCalled();
    multiselectSpy.mockRestore();
    return result;
  });
});
