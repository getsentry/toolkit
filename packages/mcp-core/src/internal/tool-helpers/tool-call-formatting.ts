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
  purpose?: string;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
  fallbackInstruction?: string;
}): string {
  const targetAvailable = isToolAvailableInSession(
    toolName,
    availableToolNames,
  );

  const toolReference = showArguments
    ? formatToolCall({ toolName, arguments: args })
    : toolName;

  if (
    targetAvailable &&
    isDirectTool(toolName, experimentalMode, directToolNames)
  ) {
    return `Use the Sentry tool \`${toolReference}\`${formatPurpose(purpose)}`;
  }

  const catalogGatewayAvailable =
    isToolAvailableInSession("search_sentry_tools", availableToolNames) &&
    isToolAvailableInSession("execute_sentry_tool", availableToolNames) &&
    isDirectTool("search_sentry_tools", experimentalMode, directToolNames) &&
    isDirectTool("execute_sentry_tool", experimentalMode, directToolNames);

  if (targetAvailable && catalogGatewayAvailable) {
    return `Use the Sentry tool \`${toolReference}\`${formatPurpose(purpose)}`;
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
