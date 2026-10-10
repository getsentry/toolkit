/**
 * Runtime Environment Variable Detection Tests
 *
 * Tests for detecting Sentry DSN from process.env, including
 * framework-prefixed variants (NEXT_PUBLIC_SENTRY_DSN, etc.).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectFromEnv, SENTRY_DSN_ENV } from "../../../src/lib/dsn/env.js";

const VALID_DSN = "https://abc123@o1.ingest.us.sentry.io/456";
const VALID_DSN_2 = "https://def456@o2.ingest.us.sentry.io/789";
const INVALID_DSN = "not-a-valid-dsn";

/** All env var names this module may read */
const ALL_DSN_VARS = [
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "REACT_APP_SENTRY_DSN",
  "VITE_SENTRY_DSN",
  "EXPO_PUBLIC_SENTRY_DSN",
  "NUXT_PUBLIC_SENTRY_DSN",
] as const;

/** Saved env values for cleanup */
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ALL_DSN_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ALL_DSN_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("detectFromEnv", () => {
  test("returns null when no DSN env vars are set", () => {
    expect(detectFromEnv()).toBeNull();
  });

  test("detects canonical SENTRY_DSN", () => {
    process.env.SENTRY_DSN = VALID_DSN;
    const result = detectFromEnv();
    expect(result).not.toBeNull();
    expect(result?.raw).toBe(VALID_DSN);
    expect(result?.source).toBe("env");
    expect(result?.sourcePath).toBe(SENTRY_DSN_ENV);
  });

  test("detects NEXT_PUBLIC_SENTRY_DSN", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = VALID_DSN;
    const result = detectFromEnv();
    expect(result).not.toBeNull();
    expect(result?.raw).toBe(VALID_DSN);
    expect(result?.sourcePath).toBe("NEXT_PUBLIC_SENTRY_DSN");
  });

  test("detects REACT_APP_SENTRY_DSN", () => {
    process.env.REACT_APP_SENTRY_DSN = VALID_DSN;
    const result = detectFromEnv();
    expect(result?.raw).toBe(VALID_DSN);
    expect(result?.sourcePath).toBe("REACT_APP_SENTRY_DSN");
  });

  test("detects VITE_SENTRY_DSN", () => {
    process.env.VITE_SENTRY_DSN = VALID_DSN;
    const result = detectFromEnv();
    expect(result?.raw).toBe(VALID_DSN);
    expect(result?.sourcePath).toBe("VITE_SENTRY_DSN");
  });

  test("detects EXPO_PUBLIC_SENTRY_DSN", () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = VALID_DSN;
    const result = detectFromEnv();
    expect(result?.raw).toBe(VALID_DSN);
    expect(result?.sourcePath).toBe("EXPO_PUBLIC_SENTRY_DSN");
  });

  test("detects NUXT_PUBLIC_SENTRY_DSN", () => {
    process.env.NUXT_PUBLIC_SENTRY_DSN = VALID_DSN;
    const result = detectFromEnv();
    expect(result?.raw).toBe(VALID_DSN);
    expect(result?.sourcePath).toBe("NUXT_PUBLIC_SENTRY_DSN");
  });

  test("canonical SENTRY_DSN takes priority over framework-prefixed vars", () => {
    process.env.SENTRY_DSN = VALID_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = VALID_DSN_2;
    const result = detectFromEnv();
    expect(result?.raw).toBe(VALID_DSN);
    expect(result?.sourcePath).toBe(SENTRY_DSN_ENV);
  });

  test("skips invalid DSN in SENTRY_DSN and falls through to framework var", () => {
    process.env.SENTRY_DSN = INVALID_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = VALID_DSN;
    const result = detectFromEnv();
    expect(result).not.toBeNull();
    expect(result?.raw).toBe(VALID_DSN);
    expect(result?.sourcePath).toBe("NEXT_PUBLIC_SENTRY_DSN");
  });

  test("skips invalid DSN in framework var and continues to next", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = INVALID_DSN;
    process.env.VITE_SENTRY_DSN = VALID_DSN;
    const result = detectFromEnv();
    expect(result?.raw).toBe(VALID_DSN);
    expect(result?.sourcePath).toBe("VITE_SENTRY_DSN");
  });

  test("returns null when all set vars contain invalid DSNs", () => {
    process.env.SENTRY_DSN = INVALID_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = "also-not-valid";
    expect(detectFromEnv()).toBeNull();
  });

  test("ignores empty string values", () => {
    process.env.SENTRY_DSN = "";
    process.env.NEXT_PUBLIC_SENTRY_DSN = VALID_DSN;
    const result = detectFromEnv();
    expect(result?.raw).toBe(VALID_DSN);
  });
});
