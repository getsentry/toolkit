/**
 * Logging and telemetry utilities for error reporting.
 *
 * Provides centralized error logging with Sentry integration. Handles both
 * console logging for development and structured error reporting for production
 * monitoring and debugging.
 */
import {
  configureSync,
  getConfig,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger as getLogTapeLogger,
  parseLogLevel,
  type LogLevel,
  type Logger,
  type LogRecord,
  type Sink,
} from "@logtape/logtape";
import {
  captureException,
  captureMessage,
  logger as sentryLogger,
  withScope,
} from "@sentry/core";

const ROOT_LOG_CATEGORY = ["sentry", "mcp"] as const;

type SinkId = "console" | "sentry";

// Invariant: every log level routes through `console.error` so LogTape's
// console sink writes to stderr, never stdout. The MCP stdio transport
// reserves stdout for JSON-RPC frames — any non-JSON-RPC line on stdout
// (LogTape records carry `@timestamp`/`level`/`message`/`logger`/`properties`,
// not `jsonrpc`/`id`/`method`) fails client framing and closes the transport.
// Severity is preserved inside the JSON record (e.g. `"level":"INFO"`); this
// map only controls which `console.*` method is called. Do not promote levels
// back to `console.info`/`console.debug` — Node sends those to stdout and
// re-introduces the stdio disconnect bug fixed in #922.
const STDERR_CONSOLE_LEVEL_MAP = {
  trace: "error",
  debug: "error",
  info: "error",
  warning: "error",
  error: "error",
  fatal: "error",
} as const;

let loggingConfigured = false;

function resolveLowestLevel(): LogLevel {
  const envLevel =
    typeof process !== "undefined" ? process.env.LOG_LEVEL : undefined;

  if (envLevel) {
    try {
      return parseLogLevel(envLevel);
    } catch (error) {
      // Fall through to default level when parsing fails.
    }
  }

  return typeof process !== "undefined" &&
    process.env.NODE_ENV === "development"
    ? "debug"
    : "info";
}

/**
 * Creates a LogTape sink that sends logs to Sentry's Logs product using Sentry.logger.
 *
 * Unlike @logtape/sentry's getSentrySink which uses captureException/captureMessage
 * (creating Issues), this sink uses Sentry.logger.* methods to send data to the
 * Logs product.
 *
 * This uses @sentry/core logger API which works across all platforms (Node.js,
 * Cloudflare Workers, etc.) as long as Sentry is initialized with the appropriate SDK.
 */
function createSentryLogsSink(): Sink {
  return (record: LogRecord) => {
    // Check if sentryLogger is available (may not be in all environments)
    if (!sentryLogger) {
      return;
    }

    // Extract message from LogRecord
    let message = "";
    for (let i = 0; i < record.message.length; i++) {
      if (i % 2 === 0) {
        message += record.message[i];
      } else {
        // Template values - convert to string safely
        const value = record.message[i];
        message += typeof value === "string" ? value : coerceMessage(value);
      }
    }

    // Extract attributes from properties
    const attributes = record.properties as Record<string, unknown>;

    // Map LogTape levels to sentryLogger methods
    // Note: sentryLogger methods are fire-and-forget and handle errors gracefully
    switch (record.level) {
      case "trace":
        sentryLogger.trace(message, attributes);
        break;
      case "debug":
        sentryLogger.debug(message, attributes);
        break;
      case "info":
        sentryLogger.info(message, attributes);
        break;
      case "warning":
        sentryLogger.warn(message, attributes);
        break;
      case "error":
        sentryLogger.error(message, attributes);
        break;
      case "fatal":
        sentryLogger.fatal(message, attributes);
        break;
      default:
        sentryLogger.info(message, attributes);
    }
  };
}

function ensureLoggingConfigured(): void {
  if (loggingConfigured) {
    return;
  }

  const consoleSink = getConsoleSink({
    formatter: getJsonLinesFormatter(),
    levelMap: STDERR_CONSOLE_LEVEL_MAP,
  });
  const sentrySink = createSentryLogsSink();

  configureSync<SinkId, never>({
    reset: getConfig() !== null,
    sinks: {
      console: consoleSink,
      sentry: sentrySink,
    },
    loggers: [
      {
        category: [...ROOT_LOG_CATEGORY],
        sinks: ["console", "sentry"],
        lowestLevel: resolveLowestLevel(),
      },
      {
        category: ["logtape", "meta"],
        sinks: ["console"],
        lowestLevel: "warning",
      },
      {
        category: "logtape",
        sinks: ["console"],
        lowestLevel: "error",
      },
    ],
  });

  loggingConfigured = true;
}

export type LogContext = Record<string, unknown>;

export type SentryLogContexts = Record<string, Record<string, unknown>>;
export type LogAttachments = Record<string, string | Uint8Array>;

export interface BaseLogOptions {
  contexts?: SentryLogContexts;
  extra?: LogContext;
  loggerScope?: string | readonly string[];
}

export interface LogIssueOptions extends BaseLogOptions {
  attachments?: LogAttachments;
}

export interface LogOptions extends BaseLogOptions {}

export function getLogger(
  scope: string | readonly string[],
  defaults?: LogContext,
): Logger {
  ensureLoggingConfigured();

  const category = Array.isArray(scope) ? scope : [scope];
  const logger = getLogTapeLogger([...ROOT_LOG_CATEGORY, ...category]);

  return defaults ? logger.with(defaults) : logger;
}

const ISSUE_LOGGER_SCOPE = ["runtime", "issues"] as const;

interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
  cause?: SerializedError;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return undefined;
  }
}

function truncate(text: string, maxLength = 1024): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function coerceMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value.toString();
  }

  if (value === null || value === undefined) {
    return String(value);
  }

  const json = safeJsonStringify(value);
  if (json) {
    return truncate(json);
  }

  return Object.prototype.toString.call(value);
}

function serializeError(value: unknown, depth = 0): SerializedError {
  if (value instanceof Error) {
    const serialized: SerializedError = {
      message: value.message,
    };

    if (value.name && value.name !== "Error") {
      serialized.name = value.name;
    }

    if (typeof value.stack === "string") {
      serialized.stack = value.stack;
    }

    const hasCause =
      "cause" in (value as { cause?: unknown }) &&
      (value as { cause?: unknown }).cause !== undefined;

    if (hasCause && depth < 3) {
      const cause = (value as { cause?: unknown }).cause;
      serialized.cause = serializeError(cause, depth + 1);
    }

    return serialized;
  }

  return { message: coerceMessage(value) };
}

export const logger = getLogger([]);

const DEFAULT_LOGGER_SCOPE: readonly string[] = [];

function buildLogProperties(
  level: LogLevel,
  options: BaseLogOptions,
  serializedError?: SerializedError,
): LogContext {
  const properties: LogContext = {
    severity: level,
  };

  if (serializedError) {
    properties.error = serializedError;
  }

  if (options.extra) {
    // Sanitize extra properties to prevent injection of protected properties
    const protectedKeys = new Set(["severity", "error", "sentryContexts"]);
    const sanitizedExtra: LogContext = {};

    for (const [key, value] of Object.entries(options.extra)) {
      if (!protectedKeys.has(key)) {
        sanitizedExtra[key] = value;
      }
    }

    Object.assign(properties, sanitizedExtra);
  }

  if (options.contexts) {
    properties.sentryContexts = options.contexts;
  }

  return properties;
}

function logWithLevel(
  level: LogLevel,
  value: unknown,
  options: LogOptions = {},
): void {
  ensureLoggingConfigured();

  const serializedError =
    value instanceof Error ? serializeError(value) : undefined;
  const message = serializedError
    ? serializedError.message
    : coerceMessage(value);
  const scope = options.loggerScope ?? DEFAULT_LOGGER_SCOPE;
  const scopedLogger = getLogger(scope, { severity: level });

  const properties = buildLogProperties(level, options, serializedError);

  switch (level) {
    case "trace":
      scopedLogger.trace(message, () => properties);
      break;
    case "debug":
      scopedLogger.debug(message, () => properties);
      break;
    case "info":
      scopedLogger.info(message, () => properties);
      break;
    case "warning":
      scopedLogger.warn(message, () => properties);
      break;
    case "error":
      scopedLogger.error(message, () => properties);
      break;
    case "fatal":
      scopedLogger.fatal(message, () => properties);
      break;
    default:
      scopedLogger.info(message, () => properties);
  }
}

export function logDebug(value: unknown, options?: LogOptions): void {
  logWithLevel("debug", value, options);
}

export function logInfo(value: unknown, options?: LogOptions): void {
  logWithLevel("info", value, options);
}

export function logWarn(value: unknown, options?: LogOptions): void {
  logWithLevel("warning", value, options);
}

export function logError(value: unknown, options?: LogOptions): void {
  logWithLevel("error", value, options);
}

export function logIssue(
  error: unknown,
  options: LogIssueOptions = {},
): string | undefined {
  ensureLoggingConfigured();

  const eventId = withScope((scopeInstance) => {
    if (options.contexts) {
      for (const [key, context] of Object.entries(options.contexts)) {
        scopeInstance.setContext(key, context);
      }
    }

    if (options.extra) {
      scopeInstance.setContext("log", options.extra);
    }

    if (options.attachments) {
      for (const [key, data] of Object.entries(options.attachments)) {
        scopeInstance.addAttachment({
          data,
          filename: key,
        });
      }
    }

    const captureLevel = "error" as const;

    return typeof error === "string"
      ? captureMessage(error, {
          contexts: options.contexts,
          level: captureLevel,
        })
      : captureException(error, {
          contexts: options.contexts,
          level: captureLevel,
        });
  });

  const { attachments, ...baseOptions } = options;
  const extra: LogContext = {
    ...baseOptions.extra,
    ...(attachments && Object.keys(attachments).length > 0
      ? { attachments: Object.keys(attachments) }
      : {}),
    ...(eventId ? { eventId } : {}),
  };

  logError(error, {
    ...baseOptions,
    extra,
    loggerScope: baseOptions.loggerScope ?? ISSUE_LOGGER_SCOPE,
  });

  return eventId;
}
