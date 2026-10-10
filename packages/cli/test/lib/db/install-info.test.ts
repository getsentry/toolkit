/**
 * Install Info Storage Tests
 */

import { describe, expect, test } from "vitest";
import {
  clearInstallInfo,
  getInstallInfo,
  setInstallInfo,
} from "../../../src/lib/db/install-info.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-install-info-");

describe("getInstallInfo", () => {
  test("returns null when no install info stored", () => {
    const result = getInstallInfo();
    expect(result).toBeNull();
  });

  test("returns stored install info", () => {
    setInstallInfo({
      method: "curl",
      path: "/home/user/.local/bin/sentry",
      version: "1.0.0",
    });

    const result = getInstallInfo();
    expect(result).not.toBeNull();
    expect(result?.method).toBe("curl");
    expect(result?.path).toBe("/home/user/.local/bin/sentry");
    expect(result?.version).toBe("1.0.0");
    expect(result?.recordedAt).toBeGreaterThan(0);
  });
});

describe("setInstallInfo", () => {
  test("stores curl install info", () => {
    setInstallInfo({
      method: "curl",
      path: "/home/user/.sentry/bin/sentry",
      version: "0.5.0",
    });

    const result = getInstallInfo();
    expect(result?.method).toBe("curl");
    expect(result?.path).toBe("/home/user/.sentry/bin/sentry");
    expect(result?.version).toBe("0.5.0");
  });

  test("stores npm install info", () => {
    setInstallInfo({
      method: "npm",
      path: "/usr/local/bin/sentry",
      version: "0.6.0",
    });

    const result = getInstallInfo();
    expect(result?.method).toBe("npm");
    expect(result?.path).toBe("/usr/local/bin/sentry");
    expect(result?.version).toBe("0.6.0");
  });

  test("stores pnpm install info", () => {
    setInstallInfo({
      method: "pnpm",
      path: "/home/user/.local/share/pnpm/sentry",
      version: "0.7.0",
    });

    const result = getInstallInfo();
    expect(result?.method).toBe("pnpm");
  });

  test("stores bun install info", () => {
    setInstallInfo({
      method: "bun",
      path: "/home/user/.bun/bin/sentry",
      version: "0.8.0",
    });

    const result = getInstallInfo();
    expect(result?.method).toBe("bun");
  });

  test("stores yarn install info", () => {
    setInstallInfo({
      method: "yarn",
      path: "/home/user/.yarn/bin/sentry",
      version: "0.9.0",
    });

    const result = getInstallInfo();
    expect(result?.method).toBe("yarn");
  });

  test("overwrites existing install info", () => {
    setInstallInfo({
      method: "curl",
      path: "/first/path",
      version: "1.0.0",
    });
    setInstallInfo({
      method: "npm",
      path: "/second/path",
      version: "2.0.0",
    });

    const result = getInstallInfo();
    expect(result?.method).toBe("npm");
    expect(result?.path).toBe("/second/path");
    expect(result?.version).toBe("2.0.0");
  });

  test("sets recordedAt timestamp", () => {
    const before = Date.now();
    setInstallInfo({
      method: "curl",
      path: "/test/path",
      version: "1.0.0",
    });
    const after = Date.now();

    const result = getInstallInfo();
    expect(result?.recordedAt).toBeGreaterThanOrEqual(before);
    expect(result?.recordedAt).toBeLessThanOrEqual(after);
  });
});

describe("clearInstallInfo", () => {
  test("removes stored install info", () => {
    setInstallInfo({
      method: "curl",
      path: "/test/path",
      version: "1.0.0",
    });

    expect(getInstallInfo()).not.toBeNull();

    clearInstallInfo();

    expect(getInstallInfo()).toBeNull();
  });

  test("does nothing when no info stored", () => {
    // Should not throw
    clearInstallInfo();
    expect(getInstallInfo()).toBeNull();
  });
});
