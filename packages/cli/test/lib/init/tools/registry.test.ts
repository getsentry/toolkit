import { describe, expect, test } from "vitest";
import {
  describeTool,
  executeTool,
} from "../../../../src/lib/init/tools/registry.js";
import type {
  ResolvedInitContext,
  ToolPayload,
} from "../../../../src/lib/init/types.js";

function makeContext(): ResolvedInitContext {
  return {
    directory: "/tmp/test",
    yes: true,
    dryRun: true,
    org: "acme",
    team: "platform",
  };
}

describe("tool registry", () => {
  test("acknowledges an agent checkpoint without local work", async () => {
    const payload: ToolPayload = {
      cwd: "/outside/project",
      detail: "Reviewing official Sentry feature support...",
      operation: "agent-checkpoint",
      params: {},
      type: "tool",
    };

    expect(describeTool(payload)).toBe(
      "Reviewing official Sentry feature support..."
    );
    await expect(executeTool(payload, makeContext())).resolves.toEqual({
      data: { acknowledged: true },
      ok: true,
    });
  });

  test("describes tool payloads via the registered definition", () => {
    const payload: ToolPayload = {
      type: "tool",
      operation: "run-commands",
      cwd: "/tmp/test",
      params: { commands: ["npm install @sentry/node"] },
    };

    expect(describeTool(payload)).toBe("Running `npm install @sentry/node`...");
  });

  test("returns an error for unknown operations", async () => {
    const payload = {
      type: "tool",
      operation: "teleport",
      cwd: "/tmp/test",
      params: {},
    } as unknown as ToolPayload;

    const result = await executeTool(payload, makeContext());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown operation");
  });

  test("describes malformed file-change payloads without throwing", () => {
    const payload = {
      cwd: "/tmp/test",
      operation: "apply-patchset",
      type: "tool",
    } as unknown as ToolPayload;

    expect(describeTool(payload)).toBe("Applying file changes...");
  });
});
