import type { DetectSentryPayload, ToolResult } from "../types.js";
import type { InitToolDefinition } from "./types.js";

/**
 * Detect existing Sentry signals in the local project directory.
 */
export async function detectSentry(cwd: string): Promise<ToolResult> {
  const { detectDsn } = await import("../../dsn/index.js");
  const dsn = await detectDsn(cwd);

  if (!dsn) {
    return { ok: true, data: { status: "none", signals: [] } };
  }

  const signals = [
    `dsn: ${dsn.source}${dsn.sourcePath ? ` (${dsn.sourcePath})` : ""}`,
  ];

  return {
    ok: true,
    data: { status: "installed", signals, dsn: dsn.raw },
  };
}

/**
 * Tool definition for Sentry install detection.
 */
export const detectSentryTool: InitToolDefinition<"detect-sentry"> = {
  operation: "detect-sentry",
  describe: () => "Checking for existing Sentry setup...",
  execute: async (payload: DetectSentryPayload) =>
    await detectSentry(payload.cwd),
};
