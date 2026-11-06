import type {
  CallToolResult,
  EmbeddedResource,
  ImageContent,
  TextContent,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Scope } from "../permissions";
import type { Skill } from "../skills";
import type { ProjectCapabilities, ServerContext } from "../types";

export type ToolContent = TextContent | ImageContent | EmbeddedResource;
export interface StructuredToolOutput<
  TStructuredContent extends Record<string, unknown> = Record<string, unknown>,
> {
  structuredContent: TStructuredContent;
  /**
   * The server generates `content` from `structuredContent`. A handler that
   * sets its own would ship it unchanged next to the payload.
   */
  content?: never;
}
export type ToolOutput =
  | string
  | ToolContent[]
  | CallToolResult
  | StructuredToolOutput;

/** Zod schema a tool can declare as its MCP `outputSchema`. */
export type ToolOutputSchema = z.ZodType<Record<string, unknown>>;

/**
 * What a handler must return for a given `outputSchema`.
 *
 * With a schema, the handler returns `structuredContent` typed as the schema's
 * `z.output`. The SDK validates the raw payload against the schema but sends
 * that raw payload, not the parse result, and advertises the schema to clients
 * in its output form (`standardSchemaToJsonSchema(schema, "output")`). So the
 * payload must already be what the schema outputs; `z.input` would accept
 * payloads that rely on defaults and break the advertised shape. Output
 * schemas must not use transforms, because the SDK cannot advertise them as
 * JSON Schema.
 *
 * Markdown, strings, and raw MCP content are only allowed without a schema.
 * Tools without a schema may still pass through another tool's structured
 * result (`execute_sentry_tool`, `get_sentry_resource`). The type distributes
 * over a union so `ToolConfig<any>` registries accept every tool.
 */
export type ToolOutputFor<TOutputSchema extends ToolOutputSchema | undefined> =
  TOutputSchema extends ToolOutputSchema
    ? StructuredToolOutput<z.output<TOutputSchema>>
    : ToolOutput;

/**
 * Keeps schema-inferred handler params at tool definition sites while allowing
 * heterogeneous tool registries to store many concrete handler signatures.
 */
export type ToolHandler<
  TSchema extends Record<string, z.ZodType>,
  TOutput extends ToolOutput = ToolOutput,
> = {
  handler(
    params: z.infer<z.ZodObject<TSchema>>,
    context: ServerContext,
  ): Promise<TOutput>;
}["handler"];

/**
 * Context passed to dynamic description functions.
 * Allows tool descriptions to vary based on server mode.
 */
export interface DescriptionContext {
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}

/**
 * Tool description can be a static string or a function that returns
 * a string based on the server context (e.g., experimental mode).
 */
export type ToolDescription =
  | string
  | ((context: DescriptionContext) => string);

/**
 * Longest allowed tool description, in characters. VS Code (via OpenAI)
 * limits descriptions to 1,024; this cap limits the damage until that rises.
 */
export const MAX_TOOL_DESCRIPTION_LENGTH = 2_048;

/**
 * Resolves a tool description to a string.
 * Handles both static strings and dynamic description functions.
 */
export function resolveDescription(
  description: ToolDescription,
  context: DescriptionContext,
): string {
  return typeof description === "function" ? description(context) : description;
}

/**
 * Determines if a tool is enabled for the current release mode.
 */
export function isToolVisibleInMode(
  tool: {
    experimental?: boolean;
    hideInExperimentalMode?: boolean;
  },
  experimentalMode: boolean,
): boolean {
  if (tool.experimental && !experimentalMode) return false;
  if (tool.hideInExperimentalMode && experimentalMode) return false;
  return true;
}

export interface ToolConfig<
  TSchema extends Record<string, z.ZodType> = Record<string, z.ZodType>,
  TOutputSchema extends ToolOutputSchema | undefined =
    | ToolOutputSchema
    | undefined,
> {
  name: string;
  /** Human-readable display name exported as the MCP tool `title`. */
  title: string;
  description: ToolDescription;
  inputSchema: TSchema;
  skills: Skill[]; // Which skill categories this tool belongs to
  includeInSkillDefinitions?: boolean; // Whether generated skill prompts advertise this tool
  requiredScopes: Scope[]; // LEGACY: Which API scopes needed (deprecated, for backward compatibility)
  experimental?: boolean; // Mark tool as experimental (only shown in experimental mode)
  hideInExperimentalMode?: boolean; // Hide tool when experimental mode is active (for tools replaced by unified tools)
  /**
   * Marks a name kept only for backward compatibility. Deprecated tools are
   * never listed in tools/list (see isTopLevelTool in surfaces.ts) but stay
   * callable through execute_sentry_tool. `replacedBy` names the tool or tools
   * new callers should use instead.
   */
  deprecated?: { replacedBy: readonly string[] };
  requiredCapabilities?: (keyof ProjectCapabilities)[]; // Project capabilities required for this tool
  /**
   * Structured result contract. When set, the handler must return
   * `structuredResult(...)` typed as this schema's output; see
   * `ToolOutputFor`.
   */
  outputSchema?: TOutputSchema;
  annotations: {
    // readOnlyHint, destructiveHint, and openWorldHint are required so every
    // tool declares its safety posture explicitly. Filters and confirmation
    // gates rely on these; an undefined hint is a silent gap. Enforced further
    // by server.metadata.test.ts ("sets every safety hint explicitly").
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
  handler: ToolHandler<TSchema, ToolOutputFor<TOutputSchema>>;
  /**
   * Optional hook invoked when the handler throws, for tool-specific failure
   * telemetry (e.g. logging the failing query). The error is still formatted
   * and returned to the client afterward; this must not throw.
   */
  onError?(
    error: unknown,
    params: Record<string, unknown>,
    context: ServerContext,
  ): void;
}

/**
 * Response from the search API endpoint
 */
export interface SearchResponse {
  query: string;
  results: Array<{
    id: string;
    url: string;
    snippet: string;
    relevance: number;
  }>;
  error?: string;
}
