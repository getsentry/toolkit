import { inlineCode } from "@sentry/toolkit-core/markdown";
import { isTopLevelToolName } from "../../tools/surfaces";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function formatArgumentValue(value: JsonValue): string {
  if (typeof value === "string") {
    return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  }

  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function formatArguments(args: Record<string, JsonValue>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${formatArgumentValue(value)}`)
    .join(", ");
}

function formatPurpose(purpose: string | undefined): string {
  return purpose ? ` ${purpose}` : "";
}

/**
 * Checks the actual session tool set; missing availability preserves legacy
 * behavior for callers that cannot provide session-scoped tool metadata.
 */
export function isToolAvailableInSession(
  toolName: string,
  availableToolNames: ReadonlySet<string> | undefined,
): boolean {
  return !availableToolNames || availableToolNames.has(toolName);
}

function isDirectTool(
  toolName: string,
  experimentalMode: boolean,
  directToolNames: ReadonlySet<string> | undefined,
): boolean {
  return directToolNames
    ? directToolNames.has(toolName)
    : isTopLevelToolName(toolName, experimentalMode);
}

/** The tools the current session exposes, for checking a follow-up call. */
export interface ToolSession {
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string> | undefined;
  directToolNames?: ReadonlySet<string> | undefined;
}

/**
 * How the session can call a tool: directly, through `execute_sentry_tool`,
 * or not at all.
 */
export function getToolCallRoute(
  toolName: string,
  { experimentalMode, availableToolNames, directToolNames }: ToolSession,
): "direct" | "execute_sentry_tool" | null {
  if (!isToolAvailableInSession(toolName, availableToolNames)) {
    return null;
  }
  if (isDirectTool(toolName, experimentalMode, directToolNames)) {
    return "direct";
  }
  return isToolAvailableInSession("execute_sentry_tool", availableToolNames) &&
    isDirectTool("execute_sentry_tool", experimentalMode, directToolNames)
    ? "execute_sentry_tool"
    : null;
}

export function formatToolCall({
  toolName,
  arguments: args = {},
}: {
  toolName: string;
  arguments?: Record<string, JsonValue>;
}): string {
  const formattedArgs = formatArguments(args);
  return `${toolName}(${formattedArgs})`;
}

/**
 * Formats user-facing tool guidance as a direct call, catalog gateway call, or
 * fallback message based on the current session's available/direct tools.
 * `showArguments` renders the full call when the arguments are concrete values
 * the agent can run as-is rather than placeholders.
 */
export function formatToolCallInstruction({
  toolName,
  arguments: args = {},
  showArguments = false,
  experimentalMode,
  purpose,
  availableToolNames,
  directToolNames,
  fallbackInstruction,
}: {
  toolName: string;
  arguments?: Record<string, JsonValue>;
  showArguments?: boolean;
  experimentalMode: boolean;
  purpose?: string | undefined;
  availableToolNames?: ReadonlySet<string> | undefined;
  directToolNames?: ReadonlySet<string> | undefined;
  fallbackInstruction?: string;
}): string {
  const route = getToolCallRoute(toolName, {
    experimentalMode,
    availableToolNames,
    directToolNames,
  });

  const toolReference = showArguments
    ? formatToolCall({ toolName, arguments: args })
    : toolName;

  if (route === "direct") {
    return `Use the Sentry tool ${inlineCode(toolReference)}${formatPurpose(purpose)}`;
  }

  // the catalog gateway also needs search to find the tool
  if (
    route === "execute_sentry_tool" &&
    isToolAvailableInSession("search_sentry_tools", availableToolNames) &&
    isDirectTool("search_sentry_tools", experimentalMode, directToolNames)
  ) {
    return `Use the Sentry tool ${inlineCode(toolReference)}${formatPurpose(purpose)}`;
  }

  return (
    fallbackInstruction ??
    `The Sentry tool \`${toolName}\` is not available in this session`
  );
}

/**
 * Formats user-facing guidance only when the target tool is available in the
 * current session; otherwise returns null so callers can omit the guidance.
 */
export function formatAvailableToolCallInstruction({
  toolName,
  experimentalMode,
  purpose,
  availableToolNames,
  directToolNames,
}: {
  toolName: string;
  experimentalMode: boolean;
  purpose?: string;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): string | null {
  if (!isToolAvailableInSession(toolName, availableToolNames)) {
    return null;
  }

  return formatToolCallInstruction({
    toolName,
    experimentalMode,
    purpose,
    availableToolNames,
    directToolNames,
  });
}
