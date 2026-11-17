import type { z } from "zod";
import type {
  ToolConfig,
  ToolHandler,
  ToolOutput,
  ToolOutputFor,
  ToolOutputSchema,
} from "../../tools/types";

type DefinedToolConfig<
  TSchema extends Record<string, z.ZodType>,
  TOutputSchema extends ToolOutputSchema | undefined,
  TResult extends ToolOutput,
> = Omit<ToolConfig<TSchema, TOutputSchema>, "handler"> & {
  handler: ToolHandler<
    TSchema,
    TOutputSchema extends ToolOutputSchema
      ? ToolOutputFor<TOutputSchema>
      : TResult
  >;
};

/**
 * Defines a catalog tool and checks its handler against its `outputSchema`.
 *
 * `TOutputSchema` is inferred from `outputSchema` (`undefined` when omitted).
 * With a schema, the handler must return `structuredResult(...)` typed as the
 * schema's `z.output`, so a payload that does not match fails tsc at the tool
 * definition with no annotations there. Without a schema, the handler's own
 * return type (`TResult`) is kept so callers and tests see what it returns.
 */
export function defineTool<
  TSchema extends Record<string, z.ZodType>,
  TResult extends ToolOutput,
  TOutputSchema extends ToolOutputSchema | undefined = undefined,
>(
  config: DefinedToolConfig<TSchema, TOutputSchema, TResult>,
): DefinedToolConfig<TSchema, TOutputSchema, TResult> {
  return config;
}
