/**
 * Unit tests for the run-commands tool.
 *
 * Kept as a mocked sibling file because vi.mock() on @sentry/node-core/light
 * must precede all module imports to take effect.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RunCommandsPayload } from "../../src/lib/init/types.js";

// ============================================================================
// Mock Setup — must precede all imports of the module under test
// ============================================================================

type Breadcrumb = {
  level: string;
  message: string;
  data: { exitCode: number; stdout: string; stderr: string; cwd: string };
};

const { breadcrumbs } = vi.hoisted(() => ({
  breadcrumbs: [] as Breadcrumb[],
}));

vi.mock("@sentry/node-core/light", () => ({
  addBreadcrumb: (crumb: Breadcrumb) => breadcrumbs.push(crumb),
}));

// Import AFTER mock setup
import { runCommands } from "../../src/lib/init/tools/run-commands.js";

// ============================================================================
// Helpers
// ============================================================================

function makePayload(commands: string[], cwd = "/tmp"): RunCommandsPayload {
  return { type: "tool", operation: "run-commands", cwd, params: { commands } };
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => breadcrumbs.splice(0));

describe("runCommands breadcrumb on failure", () => {
  test("emits an error breadcrumb with stderr when a command exits non-zero", async () => {
    // `ls /nonexistent-sentry-test-path` exits 1 on macOS/Linux with a
    // "No such file" message on stderr — a reliable non-zero exit without
    // requiring shell built-ins.
    const result = await runCommands(
      makePayload(["ls /nonexistent-sentry-test-path-xyz"]),
      { dryRun: false }
    );

    expect(result.ok).toBe(false);
    expect(breadcrumbs).toHaveLength(1);

    const crumb = breadcrumbs[0];
    expect(crumb.level).toBe("error");
    expect(crumb.message).toContain("ls");
    expect(crumb.data.exitCode).not.toBe(0);
    expect(typeof crumb.data.stdout).toBe("string");
    expect(typeof crumb.data.stderr).toBe("string");
    expect(crumb.data.cwd).toBe("/tmp");
  });

  test("does not emit a breadcrumb when the command succeeds", async () => {
    const result = await runCommands(makePayload(["echo hello"]), {
      dryRun: false,
    });

    expect(result.ok).toBe(true);
    expect(breadcrumbs).toHaveLength(0);
  });

  test("does not emit a breadcrumb in dry-run mode", async () => {
    const result = await runCommands(
      makePayload(["ls /nonexistent-sentry-test-path-xyz"]),
      { dryRun: true }
    );

    expect(result.ok).toBe(true);
    expect(breadcrumbs).toHaveLength(0);
  });
});
