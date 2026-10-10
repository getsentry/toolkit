/**
 * No-op init tool for acknowledging durable server-side agent checkpoints.
 */

import type { AgentCheckpointData, ToolResult } from "../types.js";
import type { InitToolDefinition } from "./types.js";

/** Resume a persisted agent session without performing local work. */
export const agentCheckpointTool: InitToolDefinition<"agent-checkpoint"> = {
  operation: "agent-checkpoint",
  describe: (payload) => payload.detail ?? "Continuing repository analysis...",
  execute: async (): Promise<ToolResult> => ({
    data: { acknowledged: true } satisfies AgentCheckpointData,
    ok: true,
  }),
};
