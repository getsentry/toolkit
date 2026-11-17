/**
 * Request-scoped fresh reads for MCP tool calls.
 *
 * A read tool called with `fresh: true` runs inside a scope where the shared
 * transport skips cache reads. The scope is host state, kept here with
 * `AsyncLocalStorage`; the transport sees it only through its `fresh()`
 * callback, so shared code stays free of Node APIs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ParamFresh } from "../schema";
import type { ToolConfig } from "../tools/types";

const freshScope = new AsyncLocalStorage<true>();

/** Whether the current tool call asked to bypass cached reads. */
export function isFreshRead(): boolean {
  return freshScope.getStore() === true;
}

/**
 * Add the `fresh` input to a read tool. The handler runs in a fresh scope when
 * the caller sets it, and never sees the input itself.
 */
export function withFreshReadInput<T extends ToolConfig<any>>(tool: T): T {
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema, fresh: ParamFresh },
    handler: async ({ fresh, ...params }, context) =>
      fresh === true
        ? await freshScope.run(true, () => tool.handler(params, context))
        : await tool.handler(params, context),
  };
}
