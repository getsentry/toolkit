/**
 * Seer Trial Prompt Tests
 *
 * Tests for the interactive trial prompt flow.
 * Note: isTrialEligible tests that depend on isatty(0) mocking live in
 * test/isolated/ to avoid mock.module pollution. Tests here focus on
 * promptAndStartTrial which doesn't call isatty directly.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../src/lib/api-client.js";
import { SeerError } from "../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as loggerModule from "../../src/lib/logger.js";
import {
  isTrialEligible,
  promptAndStartTrial,
} from "../../src/lib/seer-trial.js";

describe("isTrialEligible", () => {
  // Note: These tests run in a non-interactive terminal (bun test),
  // so isatty(0) returns false. We can only test the false cases here.
  // The positive case (isatty=true) would need mock.module in an isolated test.

  test("returns false for ai_disabled reason", () => {
    const err = new SeerError("ai_disabled", "test-org");
    expect(isTrialEligible(err)).toBe(false);
  });

  test("returns false when orgSlug is undefined", () => {
    const err = new SeerError("no_budget");
    expect(isTrialEligible(err)).toBe(false);
  });

  test("returns false when orgSlug is undefined for not_enabled", () => {
    const err = new SeerError("not_enabled");
    expect(isTrialEligible(err)).toBe(false);
  });

  test("returns false for non-SeerError", () => {
    expect(isTrialEligible(new Error("random error"))).toBe(false);
  });

  test("returns false for null", () => {
    expect(isTrialEligible(null)).toBe(false);
  });

  test("returns false for string", () => {
    expect(isTrialEligible("some error string")).toBe(false);
  });
});

describe("promptAndStartTrial", () => {
  let getProductTrialsSpy: ReturnType<typeof spyOn>;
  let startProductTrialSpy: ReturnType<typeof spyOn>;
  let loggerPromptSpy: ReturnType<typeof spyOn>;
  let loggerWithTagSpy: ReturnType<typeof spyOn>;
  let logDebugCalls: string[];
  let logInfoCalls: string[];
  let logWarnCalls: string[];
  let logSuccessCalls: string[];

  const MOCK_SEER_TRIAL = {
    category: "seerUsers",
    startDate: null,
    endDate: null,
    reasonCode: 0,
    isStarted: false,
    lengthDays: 14,
  };

  beforeEach(() => {
    logDebugCalls = [];
    logInfoCalls = [];
    logWarnCalls = [];
    logSuccessCalls = [];

    getProductTrialsSpy = vi
      .spyOn(apiClient, "getProductTrials")
      .mockResolvedValue([]);
    startProductTrialSpy = vi
      .spyOn(apiClient, "startProductTrial")
      .mockResolvedValue(undefined);

    // Mock the logger's withTag to return an object with all needed methods
    loggerPromptSpy = vi.spyOn({ prompt: async () => false }, "prompt");
    const mockLogInstance = {
      prompt: loggerPromptSpy,
      debug: (...args: unknown[]) => {
        logDebugCalls.push(args.map(String).join(" "));
      },
      info: (...args: unknown[]) => {
        logInfoCalls.push(args.map(String).join(" "));
      },
      warn: (...args: unknown[]) => {
        logWarnCalls.push(args.map(String).join(" "));
      },
      success: (...args: unknown[]) => {
        logSuccessCalls.push(args.map(String).join(" "));
      },
    };
    loggerWithTagSpy = vi
      .spyOn(loggerModule.logger, "withTag")
      .mockReturnValue(
        mockLogInstance as ReturnType<typeof loggerModule.logger.withTag>
      );
  });

  afterEach(() => {
    getProductTrialsSpy.mockRestore();
    startProductTrialSpy.mockRestore();
    loggerWithTagSpy.mockRestore();
  });

  test("returns false when no trial is available and shows expired message", async () => {
    getProductTrialsSpy.mockResolvedValue([]);

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(false);
    expect(getProductTrialsSpy).toHaveBeenCalledWith("test-org");
    // Should not prompt if no trial available
    expect(loggerPromptSpy).not.toHaveBeenCalled();
    // Should show expired/upgrade message
    expect(
      logInfoCalls.some((m) => m.includes("No Seer trial available"))
    ).toBe(true);
    expect(logInfoCalls.some((m) => m.includes("upgrading your plan"))).toBe(
      true
    );
  });

  test("returns false when only non-seer trials exist", async () => {
    getProductTrialsSpy.mockResolvedValue([
      { ...MOCK_SEER_TRIAL, category: "replays" },
    ]);

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(false);
    expect(loggerPromptSpy).not.toHaveBeenCalled();
  });

  test("returns false when seer trial is already started", async () => {
    getProductTrialsSpy.mockResolvedValue([
      { ...MOCK_SEER_TRIAL, isStarted: true },
    ]);

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(false);
    expect(loggerPromptSpy).not.toHaveBeenCalled();
  });

  test("returns false when trial check throws (graceful degradation)", async () => {
    getProductTrialsSpy.mockRejectedValue(new Error("Network error"));

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(false);
    expect(loggerPromptSpy).not.toHaveBeenCalled();
  });

  test("returns false when user declines the prompt", async () => {
    getProductTrialsSpy.mockResolvedValue([MOCK_SEER_TRIAL]);
    loggerPromptSpy.mockResolvedValue(false);

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(false);
    expect(logInfoCalls.some((m) => m.includes("run out of Seer quota"))).toBe(
      true
    );
    expect(startProductTrialSpy).not.toHaveBeenCalled();
  });

  test("returns false when user cancels with Ctrl+C (Symbol)", async () => {
    getProductTrialsSpy.mockResolvedValue([MOCK_SEER_TRIAL]);
    // consola returns Symbol(clack:cancel) on Ctrl+C
    loggerPromptSpy.mockResolvedValue(Symbol("clack:cancel"));

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(false);
    expect(startProductTrialSpy).not.toHaveBeenCalled();
  });

  test("starts trial and returns true on confirmation", async () => {
    getProductTrialsSpy.mockResolvedValue([MOCK_SEER_TRIAL]);
    loggerPromptSpy.mockResolvedValue(true);
    startProductTrialSpy.mockResolvedValue(undefined);

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(true);
    expect(startProductTrialSpy).toHaveBeenCalledWith("test-org", "seerUsers");
    expect(logInfoCalls.some((m) => m.includes("Starting Seer trial"))).toBe(
      true
    );
    expect(
      logSuccessCalls.some((m) => m.includes("Seer trial activated"))
    ).toBe(true);
  });

  test("prefers seerUsers over seerAutofix", async () => {
    getProductTrialsSpy.mockResolvedValue([
      { ...MOCK_SEER_TRIAL, category: "seerAutofix" },
      MOCK_SEER_TRIAL,
    ]);
    loggerPromptSpy.mockResolvedValue(true);
    startProductTrialSpy.mockResolvedValue(undefined);

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(true);
    expect(startProductTrialSpy).toHaveBeenCalledWith("test-org", "seerUsers");
  });

  test("falls back to seerAutofix when seerUsers is not available", async () => {
    getProductTrialsSpy.mockResolvedValue([
      { ...MOCK_SEER_TRIAL, category: "seerAutofix" },
    ]);
    loggerPromptSpy.mockResolvedValue(true);
    startProductTrialSpy.mockResolvedValue(undefined);

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(true);
    expect(startProductTrialSpy).toHaveBeenCalledWith(
      "test-org",
      "seerAutofix"
    );
  });

  test("returns false when trial start fails and shows settings link", async () => {
    getProductTrialsSpy.mockResolvedValue([MOCK_SEER_TRIAL]);
    loggerPromptSpy.mockResolvedValue(true);
    startProductTrialSpy.mockRejectedValue(new Error("API error"));

    const result = await promptAndStartTrial("test-org", "no_budget");

    expect(result).toBe(false);
    expect(logWarnCalls.some((m) => m.includes("Failed to start trial"))).toBe(
      true
    );
    // Should include a link to billing/settings
    expect(
      logWarnCalls.some((m) => m.includes("settings/billing/overview"))
    ).toBe(true);
    // Should mention support contact
    expect(logWarnCalls.some((m) => m.includes("support@sentry"))).toBe(true);
  });

  test("shows correct context message for not_enabled reason", async () => {
    getProductTrialsSpy.mockResolvedValue([MOCK_SEER_TRIAL]);
    loggerPromptSpy.mockResolvedValue(false);

    await promptAndStartTrial("test-org", "not_enabled");

    expect(
      logInfoCalls.some((m) => m.includes("not enabled for your organization"))
    ).toBe(true);
  });

  test("shows correct context message for no_budget reason", async () => {
    getProductTrialsSpy.mockResolvedValue([MOCK_SEER_TRIAL]);
    loggerPromptSpy.mockResolvedValue(false);

    await promptAndStartTrial("test-org", "no_budget");

    expect(logInfoCalls.some((m) => m.includes("run out of Seer quota"))).toBe(
      true
    );
  });

  test("includes trial length in prompt message", async () => {
    getProductTrialsSpy.mockResolvedValue([MOCK_SEER_TRIAL]);
    loggerPromptSpy.mockResolvedValue(false);

    await promptAndStartTrial("test-org", "no_budget");

    expect(loggerPromptSpy).toHaveBeenCalled();
    const promptMessage = loggerPromptSpy.mock.calls[0]?.[0] as string;
    expect(promptMessage).toContain("14-day");
  });

  test("omits trial length when null", async () => {
    getProductTrialsSpy.mockResolvedValue([
      { ...MOCK_SEER_TRIAL, lengthDays: null },
    ]);
    loggerPromptSpy.mockResolvedValue(false);

    await promptAndStartTrial("test-org", "no_budget");

    expect(loggerPromptSpy).toHaveBeenCalled();
    const promptMessage = loggerPromptSpy.mock.calls[0]?.[0] as string;
    expect(promptMessage).not.toContain("day");
    expect(promptMessage).toContain("free Seer trial");
  });
});
