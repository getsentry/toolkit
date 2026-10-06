/**
 * CLI Route Tests
 *
 * Tests for the sentry cli command group.
 *
 * Progress messages go through consola (→ process.stderr). Final results are
 * returned as structured data and rendered to stdout by the output system.
 * Tests capture both stderr (progress) and stdout (results) to verify behavior.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { feedbackCommand } from "../../src/commands/cli/feedback.js";
import type { UpgradeResult } from "../../src/commands/cli/upgrade.js";
import { upgradeCommand } from "../../src/commands/cli/upgrade.js";

/**
 * Create a mock context with a process.stderr.write spy for capturing
 * consola output, plus stdout capture for structured output.
 */
function createMockContext(overrides: Partial<{ execPath: string }> = {}): {
  context: Record<string, unknown>;
  getStderr: () => string;
  getStdout: () => string;
  errors: string[];
  restore: () => void;
} {
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const errors: string[] = [];

  // Capture consola output (routed to process.stderr)
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const context = {
    process: { execPath: overrides.execPath ?? "/test/path/sentry" },
    stdout: {
      write: (s: string) => {
        stdoutChunks.push(s);
        return true;
      },
    },
    stderr: {
      write: (s: string) => {
        errors.push(s);
        return true;
      },
    },
  };

  return {
    context,
    getStderr: () => stderrChunks.join(""),
    getStdout: () => stdoutChunks.join(""),
    errors,
    restore: () => {
      process.stderr.write = origWrite;
    },
  };
}

describe("feedbackCommand.func", () => {
  test("throws ValidationError for empty message", async () => {
    // Access func through loader
    const func = await feedbackCommand.loader();
    const mockContext = {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    };

    await expect(func.call(mockContext, {}, "")).rejects.toThrow(
      "Please provide a feedback message."
    );
  });

  test("throws ValidationError for whitespace-only message", async () => {
    const func = await feedbackCommand.loader();
    const mockContext = {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    };

    await expect(func.call(mockContext, {}, "   ")).rejects.toThrow(
      "Please provide a feedback message."
    );
  });

  test("throws ConfigError when Sentry is disabled", async () => {
    const func = await feedbackCommand.loader();
    const mockContext = {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    };

    // Sentry is disabled in test environment (no DSN)
    await expect(
      func.call(mockContext, {}, "test", "feedback")
    ).rejects.toThrow("Feedback not sent: telemetry is disabled.");
  });
});

// Test the upgrade command func
describe("upgradeCommand.func", () => {
  let originalFetch: typeof globalThis.fetch;
  let restoreStderr: (() => void) | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    restoreStderr?.();
    restoreStderr = undefined;
    globalThis.fetch = originalFetch;
  });

  // Note: We skip testing "unknown installation method" case because
  // detectInstallationMethod() runs actual shell commands (npm list, etc.)
  // which can be slow/flaky in CI. The unknown method handling is tested
  // indirectly through the upgrade.ts unit tests in lib/upgrade.test.ts.

  test("shows installation info with specified method", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ tag_name: "cli@1.0.0" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const func = await upgradeCommand.loader();
    const { context, getStdout, restore } = createMockContext();
    restoreStderr = restore;

    // Use method flag to bypass detection (curl uses GitHub).
    // Pass json: true so the output config renders structured JSON to stdout.
    await func.call(context, { check: true, method: "curl", json: true });

    // Final result is rendered as JSON to stdout by the output system
    const data = JSON.parse(getStdout()) as UpgradeResult;
    expect(data.action).toBe("checked");
    expect(data.method).toBe("curl");
  });

  test("check mode shows update available", async () => {
    // Curl uses the Toolkit GitHub release list with product-prefixed tags.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ tag_name: "cli@99.0.0" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const func = await upgradeCommand.loader();
    const { context, getStdout, restore } = createMockContext();
    restoreStderr = restore;

    await func.call(context, { check: true, method: "curl", json: true });

    const data = JSON.parse(getStdout()) as UpgradeResult;
    expect(data.action).toBe("checked");
    expect(data.targetVersion).toBe("99.0.0");
    expect(data.warnings).toContain("Run 'sentry cli upgrade' to update.");
  });

  test("check mode with version shows versioned command", async () => {
    globalThis.fetch = (async (url) => {
      const response = String(url).includes("/releases/tags/cli%402.0.0")
        ? { tag_name: "cli@2.0.0" }
        : [{ tag_name: "cli@99.0.0" }];
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const func = await upgradeCommand.loader();
    const { context, getStdout, restore } = createMockContext();
    restoreStderr = restore;

    await func.call(
      context,
      { check: true, method: "curl", json: true },
      "2.0.0"
    );

    const data = JSON.parse(getStdout()) as UpgradeResult;
    expect(data.action).toBe("checked");
    expect(data.warnings).toContain(
      "Run 'sentry cli upgrade 2.0.0' to update."
    );
  });

  test("check mode compares the current version with a stable target", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ tag_name: "cli@1.0.0" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const func = await upgradeCommand.loader();
    const { context, getStdout, restore } = createMockContext();
    restoreStderr = restore;

    await func.call(context, { check: true, method: "curl", json: true });

    const data = JSON.parse(getStdout()) as UpgradeResult;
    expect(data.action).toBe("checked");
    expect(data.currentVersion).toBe("0.0.0-dev");
    expect(data.targetVersion).toBe("1.0.0");
  });

  test("throws UpgradeError when specified version does not exist", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    const func = await upgradeCommand.loader();
    const { context, restore } = createMockContext();
    restoreStderr = restore;

    // Specify a version that doesn't exist
    await expect(
      func.call(context, { check: false, method: "curl" }, "999.0.0")
    ).rejects.toThrow("Version 999.0.0 not found");
    expect(callCount).toBe(2);
  });
});
