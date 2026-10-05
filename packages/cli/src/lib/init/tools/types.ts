import type {
  ResolvedInitContext,
  ToolOperation,
  ToolPayload,
  ToolResult,
} from "../types.js";

/**
 * Client-side context available to init tools while the workflow is suspended.
 */
export type ToolContext = ResolvedInitContext;

/**
 * A single init tool implementation plus its user-facing spinner copy.
 */
export type InitToolDefinition<TOperation extends ToolOperation> = {
  /** Stable operation name used in suspend payloads. */
  operation: TOperation;
  /** Build a short spinner message for the current payload. */
  describe: (
    payload: Extract<ToolPayload, { operation: TOperation }>
  ) => string;
  /** Execute the tool and return a resumable payload result. */
  execute: (
    payload: Extract<ToolPayload, { operation: TOperation }>,
    context: ToolContext
  ) => Promise<ToolResult>;
};

/**
 * Union of all concrete init tool definitions.
 */
export type AnyInitToolDefinition = {
  [Operation in ToolOperation]: InitToolDefinition<Operation>;
}[ToolOperation];
