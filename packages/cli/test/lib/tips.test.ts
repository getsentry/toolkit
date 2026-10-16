/**
 * Tip-hint suppression tests (getsentry/toolkit#1479).
 *
 * Covers `tipsSuppressed()` precedence between `SENTRY_DISABLE_TIPS` and the
 * stored `defaults.tips` preference, and `stripTips()` keeping non-tip lines.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setTipsPreference } from "../../src/lib/db/defaults.js";
import { setEnv } from "../../src/lib/env.js";
import {
  applyTipsPreference,
  resetTipsCache,
  stripTips,
  tipsSuppressed,
} from "../../src/lib/tips.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-tips-");

/** Point getEnv() at process.env with SENTRY_DISABLE_TIPS set or removed. */
function setTipsEnv(value?: string): void {
  const env = { ...process.env };
  delete env.SENTRY_DISABLE_TIPS;
  setEnv(value === undefined ? env : { ...env, SENTRY_DISABLE_TIPS: value });
}

describe("tipsSuppressed", () => {
  beforeEach(() => {
    setTipsEnv();
  });

  afterEach(() => {
    setEnv(process.env);
  });

  test("shows tips by default (no env, no preference)", () => {
    expect(tipsSuppressed()).toBe(false);
  });

  test("suppresses tips when the stored preference is off", () => {
    setTipsPreference(false);
    expect(tipsSuppressed()).toBe(true);
  });

  test("shows tips when the stored preference is on", () => {
    setTipsPreference(true);
    expect(tipsSuppressed()).toBe(false);
  });

  test("memoizes per env until the cache is reset", () => {
    expect(tipsSuppressed()).toBe(false);
    setTipsPreference(false);
    expect(tipsSuppressed()).toBe(false);
    resetTipsCache();
    expect(tipsSuppressed()).toBe(true);
  });

  test("truthy SENTRY_DISABLE_TIPS wins over the stored preference", () => {
    setTipsPreference(true);
    for (const val of ["1", "true", "yes"]) {
      setTipsEnv(val);
      expect(tipsSuppressed()).toBe(true);
    }
  });

  test("falsy SENTRY_DISABLE_TIPS falls through to the stored preference", () => {
    for (const val of ["0", "false", ""]) {
      setTipsEnv(val);
      setTipsPreference(null);
      resetTipsCache();
      expect(tipsSuppressed()).toBe(false);
      setTipsPreference(false);
      resetTipsCache();
      expect(tipsSuppressed()).toBe(true);
    }
  });
});

describe("stripTips", () => {
  test("drops a hint that is only a tip", () => {
    expect(
      stripTips(
        "Tip: Use 'sentry issue explain CLI-1' for AI root cause analysis",
      ),
    ).toBeUndefined();
  });

  test("keeps non-tip lines", () => {
    expect(
      stripTips(
        "Showing 10 of 25 organizations\nTip: Use 'sentry org view <slug>' for details",
      ),
    ).toBe("Showing 10 of 25 organizations");
  });

  test("cuts a tip that trails other text on the same line", () => {
    expect(
      stripTips(
        "Missing: web, api. Tip: Use 'sentry project list acme/' to see all projects",
      ),
    ).toBe("Missing: web, api.");
  });

  test("leaves hints without tips unchanged", () => {
    const hint = "No issues found.\n\nDetected from .env file";
    expect(stripTips(hint)).toBe(hint);
  });

  test("trims blank lines left at the edges", () => {
    expect(
      stripTips("No projects found.\n\nTip: Use 'sentry project list'"),
    ).toBe("No projects found.");
  });
});

describe("applyTipsPreference", () => {
  afterEach(() => {
    setEnv(process.env);
  });

  test("returns the hint unchanged when tips are enabled", () => {
    setTipsEnv();
    const hint = "Showing 5 items\nTip: Use 'sentry thing view <id>'";
    expect(applyTipsPreference(hint)).toBe(hint);
  });

  test("strips tips when SENTRY_DISABLE_TIPS is set", () => {
    setTipsEnv("1");
    expect(
      applyTipsPreference("Showing 5 items\nTip: Use 'sentry thing view <id>'"),
    ).toBe("Showing 5 items");
  });

  test("passes undefined through", () => {
    expect(applyTipsPreference(undefined)).toBeUndefined();
  });
});
