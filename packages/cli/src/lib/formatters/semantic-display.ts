/**
 * OTel semantic attribute rendering for local dev server output.
 *
 * Ported from sentry-mcp's trace-semantic-display.ts (PR #981) and adapted
 * for raw Sentry envelope items. Renders span/transaction labels from
 * OpenTelemetry semantic attributes before falling back to Sentry op/name.
 *
 * Covers: GenAI, MCP, HTTP, database, GraphQL, RPC/cloud, messaging,
 * FaaS, object stores, CloudEvents, CICD, feature flags, process,
 * exception, and error attributes.
 */

import { logger } from "../logger.js";

const log = logger.withTag("semantic-display");

/** Display result from semantic rendering. */
export type SemanticSpanDisplay = {
  /** Primary label for the span/transaction. */
  label: string;
  /** Additional metadata tokens shown after the label. */
  metadata: string[];
};

/** A function that attempts to render semantic display for an item. */
type SpanDisplayFormatter = (
  attrs: AttributeSource,
  fallbackLabel: string
) => SemanticSpanDisplay | null;

const SPAN_LABEL_MAX_LENGTH = 120;
const SPAN_METADATA_MAX_LENGTH = 64;
const SPAN_ATTRIBUTE_MAX_LENGTH = 2048;

/** Matches a URL scheme prefix like `https://` or `ftp://`. */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Ordered list of semantic formatters. The first match wins.
 * MCP before HTTP so `tools/call` isn't masked by transport-level `POST /mcp`.
 */
const SEMANTIC_SPAN_FORMATTERS: SpanDisplayFormatter[] = [
  formatMcpSpanDisplay,
  formatGenAiSpanDisplay,
  formatHttpSpanDisplay,
  formatDatabaseSpanDisplay,
  formatGraphqlSpanDisplay,
  formatObjectStoreSpanDisplay,
  formatRpcSpanDisplay,
  formatMessagingSpanDisplay,
  formatCloudEventsSpanDisplay,
  formatFaasSpanDisplay,
  formatCicdSpanDisplay,
  formatFeatureFlagSpanDisplay,
  formatProcessSpanDisplay,
  formatExceptionSpanDisplay,
  formatErrorSpanDisplay,
];

/**
 * Abstraction over attribute sources. In raw envelopes, attributes live in
 * `contexts.trace.data` or individual span `data` objects.
 */
export type AttributeSource = Record<string, unknown>;

/**
 * Semantic-convention key prefixes that mark an attribute source as carrying
 * GenAI or MCP activity. Used by the `-f ai` filter, which must match any
 * GenAI/MCP attribute — not just the `gen_ai.operation.name`/tool/agent keys
 * that {@link inferSemanticOp} keys off. Vercel-AI-style spans frequently
 * carry only `gen_ai.request.model` or `gen_ai.usage.*`, so prefix matching
 * is required to avoid missing them.
 */
const AI_ATTRIBUTE_PREFIXES = ["gen_ai.", "mcp."] as const;

/**
 * Whether an attribute source contains any GenAI or MCP attribute, detected by
 * key prefix. Unlike {@link inferSemanticOp}, this matches the full GenAI/MCP
 * namespace (e.g. `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
 * `mcp.tool.name`), not just the handful of op-defining keys.
 */
export function hasAiAttributes(attrs: AttributeSource): boolean {
  for (const key of Object.keys(attrs)) {
    const lower = key.toLowerCase();
    if (AI_ATTRIBUTE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

/** Look up an attribute value by trying multiple keys in order. */
function getAttr(
  attrs: AttributeSource,
  keys: string[],
  maxLength = SPAN_METADATA_MAX_LENGTH
): string | undefined {
  for (const key of keys) {
    if (Object.hasOwn(attrs, key)) {
      const value = formatDisplayPart(attrs[key], maxLength);
      if (value) {
        return value;
      }
    }
  }
  return;
}

/**
 * Build a semantic display for a transaction or span from its attributes.
 *
 * @param attrs - Merged attribute object from the envelope item
 * @param fallbackLabel - The transaction name or span description to use as fallback
 * @returns A SemanticSpanDisplay with label and metadata, or the fallback
 */
export function formatSemanticSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay {
  for (const formatter of SEMANTIC_SPAN_FORMATTERS) {
    const result = formatter(attrs, fallbackLabel);
    if (result) {
      return {
        label: truncate(result.label, SPAN_LABEL_MAX_LENGTH) || "unnamed",
        metadata: dedupeMetadata(result.metadata),
      };
    }
  }
  return { label: fallbackLabel, metadata: [] };
}

/**
 * Derive a semantic op category from attributes for the `[op]` display.
 * Returns undefined if no semantic category is detected (falls back to trace.op).
 *
 * Only domains with a natural one-word op category are included.
 * CloudEvents, CICD, FeatureFlag, Exception, and Error are intentionally
 * omitted — they should preserve the original trace.op.
 * HTTP also returns undefined to keep the SDK-assigned op (e.g. `http.client`).
 * S3 is checked before RPC since S3 spans carry `rpc.method` but should
 * be tagged as `s3` rather than `rpc`.
 */
export function inferSemanticOp(attrs: AttributeSource): string | undefined {
  if (getAttr(attrs, ["mcp.method.name"])) {
    return "mcp";
  }
  if (
    getAttr(attrs, [
      "gen_ai.operation.name",
      "gen_ai.tool.name",
      "gen_ai.agent.name",
    ])
  ) {
    return "gen_ai";
  }
  if (getAttr(attrs, ["http.request.method", "http.response.status_code"])) {
    return;
  }
  if (
    getAttr(attrs, ["db.system.name", "db.query.summary", "db.operation.name"])
  ) {
    return "db";
  }
  if (getAttr(attrs, ["graphql.operation.type"])) {
    return "graphql";
  }
  // Check S3/object store before RPC — S3 spans carry rpc.method but should
  // be displayed as object store operations, not generic RPC.
  if (getAttr(attrs, ["aws.s3.bucket", "aws.s3.key"])) {
    return "s3";
  }
  if (getAttr(attrs, ["rpc.system.name", "rpc.service"])) {
    return "rpc";
  }
  if (getAttr(attrs, ["messaging.system", "messaging.operation.name"])) {
    return "messaging";
  }
  if (getAttr(attrs, ["faas.trigger", "faas.invoked_name"])) {
    return "faas";
  }
  if (getAttr(attrs, ["process.executable.name", "process.command"])) {
    return "process";
  }
  return;
}

// ---------------------------------------------------------------------------
// Semantic formatters — each returns null if the span doesn't match
// ---------------------------------------------------------------------------

function formatGenAiSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const operation = getAttr(attrs, ["gen_ai.operation.name"]);
  const toolName = getAttr(attrs, ["gen_ai.tool.name"]);
  const agentName = getAttr(attrs, ["gen_ai.agent.name"]);
  const model = getGenAiModelIdentifier(attrs);
  const dataSourceId = getAttr(attrs, ["gen_ai.data_source.id"]);
  const errorType = getErrorType(attrs);

  if (!(operation || toolName || agentName || model || dataSourceId)) {
    return null;
  }

  const subject = toolName ?? agentName ?? model ?? dataSourceId;
  const label = operation
    ? formatOperationLabel(operation, subject)
    : subject || fallbackLabel;

  return {
    label,
    metadata: compactStrings([
      subject === model ? undefined : model,
      errorType,
    ]),
  };
}

function formatMcpSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const method = getAttr(attrs, ["mcp.method.name"]);
  const resourceUri = getAttr(
    attrs,
    ["mcp.resource.uri"],
    SPAN_ATTRIBUTE_MAX_LENGTH
  );
  const target =
    getAttr(attrs, ["gen_ai.tool.name", "gen_ai.prompt.name"]) ??
    formatResourceTarget(resourceUri);
  const statusCode = getAttr(attrs, ["rpc.response.status_code"]);
  const errorType = getErrorType(attrs);

  if (!(method || resourceUri)) {
    return null;
  }

  return {
    label: joinParts([method, target]) || fallbackLabel,
    metadata: compactStrings([statusCode, errorType]),
  };
}

function formatHttpSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const method = getAttr(attrs, ["http.request.method"])?.toUpperCase();
  const statusCode = getAttr(attrs, ["http.response.status_code"]);
  const target = getHttpTarget(attrs, {
    includeServerTarget: Boolean(method || statusCode),
  });
  const errorType = getErrorType(attrs);

  if (!(method || target || statusCode)) {
    return null;
  }

  const label = formatHttpLabel({ method, target, fallbackLabel });

  return {
    label: label || fallbackLabel,
    metadata: compactStrings([statusCode, errorType]),
  };
}

function formatDatabaseSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const dbSystem = getAttr(attrs, ["db.system.name"]);
  const querySummary = getAttr(attrs, ["db.query.summary"]);
  const operationName = getAttr(attrs, ["db.operation.name"]);
  const target =
    getAttr(attrs, ["db.collection.name", "db.namespace"]) ??
    getServerTarget(attrs);
  const storedProcedure = getAttr(attrs, ["db.stored_procedure.name"]);
  const queryText = getAttr(
    attrs,
    ["db.query.text"],
    SPAN_ATTRIBUTE_MAX_LENGTH
  );

  if (
    !(
      dbSystem ||
      querySummary ||
      operationName ||
      target ||
      storedProcedure ||
      queryText
    )
  ) {
    return null;
  }

  const label =
    querySummary ??
    (storedProcedure ? `CALL ${storedProcedure}` : undefined) ??
    (joinParts([operationName, target]) || undefined) ??
    formatDbQueryText(queryText) ??
    fallbackLabel;
  const statusCode = getAttr(attrs, ["db.response.status_code"]);
  const errorType = getErrorType(attrs);

  return {
    label,
    metadata: compactStrings([dbSystem, statusCode, errorType]),
  };
}

function formatGraphqlSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const operationType = getAttr(attrs, ["graphql.operation.type"]);
  const operationName = getAttr(attrs, ["graphql.operation.name"]);
  const document = getAttr(
    attrs,
    ["graphql.document"],
    SPAN_ATTRIBUTE_MAX_LENGTH
  );

  if (!(operationType || operationName || document)) {
    return null;
  }

  return {
    label:
      joinParts([operationType, operationName]) ||
      truncate(document, SPAN_LABEL_MAX_LENGTH) ||
      fallbackLabel,
    metadata: [],
  };
}

function formatRpcSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const rpcSystem = getAttr(attrs, ["rpc.system.name"]);
  const service = getAttr(attrs, ["rpc.service"]);
  const method = getAttr(attrs, ["rpc.method"]);
  const statusCode = getAttr(attrs, ["rpc.response.status_code"]);
  const region = getAttr(attrs, ["cloud.region"]);
  const errorType = getErrorType(attrs);

  if (!(rpcSystem || service || method || statusCode)) {
    return null;
  }

  const methodLabel =
    service && method ? `${service}/${method}` : method || service;

  return {
    label: methodLabel || fallbackLabel,
    metadata: compactStrings([rpcSystem, statusCode, region, errorType]),
  };
}

function formatMessagingSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const messagingSystem = getAttr(attrs, ["messaging.system"]);
  const operation = getAttr(attrs, [
    "messaging.operation.name",
    "messaging.operation.type",
  ]);
  const destination = getAttr(attrs, [
    "messaging.destination.template",
    "messaging.destination.name",
    "messaging.destination.subscription.name",
  ]);
  const consumerGroup = getAttr(attrs, ["messaging.consumer.group.name"]);
  const messageCount = getAttr(attrs, ["messaging.batch.message_count"]);
  const errorType = getErrorType(attrs);

  if (!(messagingSystem || operation || destination)) {
    return null;
  }

  return {
    label: joinParts([operation, destination]) || fallbackLabel,
    metadata: compactStrings([
      messagingSystem,
      consumerGroup,
      messageCount ? `messages:${messageCount}` : undefined,
      errorType,
    ]),
  };
}

function formatFaasSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const trigger = getAttr(attrs, ["faas.trigger"]);
  const name = getAttr(attrs, ["faas.invoked_name", "faas.name"]);
  const provider = getAttr(attrs, ["faas.invoked_provider"]);
  const region = getAttr(attrs, ["faas.invoked_region"]);
  const coldStart = getAttr(attrs, ["faas.coldstart"]);
  const documentOperation = getAttr(attrs, ["faas.document.operation"]);
  const documentTarget = getAttr(attrs, [
    "faas.document.collection",
    "faas.document.name",
  ]);
  const cron = getAttr(attrs, ["faas.cron"]);
  const errorType = getErrorType(attrs);
  const isColdStart = coldStart === "true";

  if (
    !(
      trigger ||
      name ||
      provider ||
      region ||
      isColdStart ||
      documentOperation ||
      documentTarget ||
      cron
    )
  ) {
    return null;
  }

  return {
    label:
      joinParts([
        trigger,
        name,
        joinParts([documentOperation, documentTarget]) || cron,
      ]) || fallbackLabel,
    metadata: compactStrings([
      provider,
      region,
      isColdStart ? "coldstart" : undefined,
      errorType,
    ]),
  };
}

function formatProcessSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const command = getAttr(attrs, [
    "process.executable.name",
    "process.command",
  ]);
  const exitCode = getAttr(attrs, ["process.exit.code"]);
  const errorType = getErrorType(attrs);

  if (!(command || exitCode)) {
    return null;
  }

  return {
    label: command || fallbackLabel,
    metadata: compactStrings([
      exitCode ? `exit:${exitCode}` : undefined,
      errorType,
    ]),
  };
}

function formatObjectStoreSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const bucket = getAttr(attrs, ["aws.s3.bucket"]);
  const key = getAttr(attrs, ["aws.s3.key"], SPAN_ATTRIBUTE_MAX_LENGTH);
  const copySource = getAttr(
    attrs,
    ["aws.s3.copy_source"],
    SPAN_ATTRIBUTE_MAX_LENGTH
  );
  const operation = getAttr(attrs, ["rpc.method"]);
  const region = getAttr(attrs, ["cloud.region"]);
  const errorType = getErrorType(attrs);
  const target =
    formatObjectStoreTarget(bucket, key) ??
    truncate(copySource, SPAN_LABEL_MAX_LENGTH);

  if (!(bucket || key || copySource)) {
    return null;
  }

  return {
    label: joinParts([operation, target]) || fallbackLabel,
    metadata: compactStrings([region, errorType]),
  };
}

function formatCloudEventsSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const eventType = getAttr(attrs, ["cloudevents.event_type"]);
  const eventSubject = getAttr(attrs, ["cloudevents.event_subject"]);
  const eventSource = getAttr(
    attrs,
    ["cloudevents.event_source"],
    SPAN_ATTRIBUTE_MAX_LENGTH
  );
  const specVersion = getAttr(attrs, ["cloudevents.event_spec_version"]);

  if (!(eventType || eventSubject || eventSource || specVersion)) {
    return null;
  }

  return {
    label:
      joinParts([
        eventType,
        eventSubject ?? formatResourceTarget(eventSource),
      ]) || fallbackLabel,
    metadata: specVersion ? [`cloudevents:${specVersion}`] : [],
  };
}

function formatCicdSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const action = getAttr(attrs, ["cicd.pipeline.action.name"]);
  const pipeline = getAttr(attrs, ["cicd.pipeline.name"]);
  const pipelineResult = getAttr(attrs, ["cicd.pipeline.result"]);
  const taskName = getAttr(attrs, ["cicd.pipeline.task.name"]);
  const taskResult = getAttr(attrs, ["cicd.pipeline.task.run.result"]);
  const errorType = getErrorType(attrs);

  if (!(action || pipeline || pipelineResult || taskName || taskResult)) {
    return null;
  }

  return {
    label: joinParts([action, pipeline]) || taskName || fallbackLabel,
    metadata: compactStrings([pipelineResult, taskResult, errorType]),
  };
}

function formatFeatureFlagSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const flagKey = getAttr(attrs, ["feature_flag.key"]);
  const variant = getAttr(attrs, ["feature_flag.result.variant"]);
  const value = getAttr(attrs, ["feature_flag.result.value"]);
  const provider = getAttr(attrs, ["feature_flag.provider.name"]);
  const reason = getAttr(attrs, ["feature_flag.result.reason"]);
  const errorType = getErrorType(attrs);

  if (!(flagKey || variant || value || provider || reason)) {
    return null;
  }

  return {
    label: joinParts([flagKey, variant ?? value]) || fallbackLabel,
    metadata: compactStrings([provider, reason, errorType]),
  };
}

function formatExceptionSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const exceptionType = getAttr(attrs, ["exception.type"]);
  const exceptionMessage = getAttr(
    attrs,
    ["exception.message"],
    SPAN_ATTRIBUTE_MAX_LENGTH
  );

  if (!(exceptionType || exceptionMessage)) {
    return null;
  }

  const label =
    fallbackLabel === "unnamed"
      ? exceptionType || exceptionMessage || fallbackLabel
      : fallbackLabel;
  const metadata =
    fallbackLabel === "unnamed"
      ? []
      : compactStrings([
          exceptionType,
          exceptionType ? undefined : exceptionMessage,
        ]);

  return { label, metadata };
}

function formatErrorSpanDisplay(
  attrs: AttributeSource,
  fallbackLabel: string
): SemanticSpanDisplay | null {
  const errorType = getErrorType(attrs);
  if (!errorType) {
    return null;
  }
  return { label: fallbackLabel, metadata: [errorType] };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getGenAiModelIdentifier(attrs: AttributeSource): string | undefined {
  const provider = getAttr(attrs, ["gen_ai.provider.name"]);
  const model = getAttr(attrs, [
    "gen_ai.response.model",
    "gen_ai.request.model",
  ]);

  if (!model) {
    return provider;
  }
  if (!provider || model.includes("/")) {
    return model;
  }
  return `${provider}/${model}`;
}

function getHttpTarget(
  attrs: AttributeSource,
  { includeServerTarget = false }: { includeServerTarget?: boolean } = {}
): string | undefined {
  const route = getAttr(
    attrs,
    ["http.route", "url.template"],
    SPAN_ATTRIBUTE_MAX_LENGTH
  );
  const fullUrl = getAttr(attrs, ["url.full"], SPAN_ATTRIBUTE_MAX_LENGTH);
  const path = getAttr(attrs, ["url.path"], SPAN_ATTRIBUTE_MAX_LENGTH);
  const serverTarget = getServerTarget(attrs);

  if (route) {
    return formatHttpTarget(route);
  }
  if (fullUrl) {
    return formatHttpTarget(fullUrl);
  }
  if (path) {
    return formatHttpTarget(path);
  }
  if (includeServerTarget && serverTarget) {
    return formatHttpTarget(serverTarget);
  }
  return;
}

function getServerTarget(attrs: AttributeSource): string | undefined {
  const address = getAttr(attrs, ["server.address"]);
  const port = getAttr(attrs, ["server.port"]);
  if (!address) {
    return;
  }
  if (!port || address.includes(":")) {
    return address;
  }
  return `${address}:${port}`;
}

function formatHttpLabel({
  method,
  target,
  fallbackLabel,
}: {
  method?: string;
  target?: string;
  fallbackLabel: string;
}): string {
  if (method && target) {
    return joinParts([method, target]);
  }
  if (target) {
    return target;
  }

  const normalized = fallbackLabel.toUpperCase();
  if (method && normalized !== method && fallbackLabel !== "unnamed") {
    return normalized.startsWith(`${method} `)
      ? fallbackLabel
      : joinParts([method, fallbackLabel]);
  }
  return method || fallbackLabel;
}

function formatHttpTarget(value: string): string {
  const trimmed = value.trim();
  if (!URL_SCHEME_RE.test(trimmed)) {
    const noFragment = trimmed.split("#")[0] ?? trimmed;
    return noFragment.split("?")[0] ?? noFragment;
  }
  try {
    const url = new URL(trimmed);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host}${path}`;
  } catch (error) {
    log.debug("Failed to parse URL for HTTP target display", error);
    const noFragment = trimmed.split("#")[0] ?? trimmed;
    return noFragment.split("?")[0] ?? noFragment;
  }
}

function formatOperationLabel(operation: string, subject?: string): string {
  return subject ? `${operation} ${subject}` : operation;
}

function formatObjectStoreTarget(
  bucket?: string,
  key?: string
): string | undefined {
  if (bucket && key) {
    return truncate(`${bucket}/${key}`, SPAN_LABEL_MAX_LENGTH);
  }
  return bucket ?? truncate(key, SPAN_LABEL_MAX_LENGTH);
}

function formatResourceTarget(value?: string): string | undefined {
  if (!value) {
    return;
  }
  return truncate(value.split("?")[0], SPAN_LABEL_MAX_LENGTH);
}

function formatDbQueryText(value?: string): string | undefined {
  if (!value) {
    return;
  }
  return truncate(
    value.replace(/'([^']|'')*'/g, "?").replace(/\b\d+(\.\d+)?\b/g, "?"),
    SPAN_LABEL_MAX_LENGTH
  );
}

function joinParts(values: Array<string | undefined>): string {
  return compactStrings(values).join(" ");
}

function compactStrings(values: Array<string | undefined>): string[] {
  return values.filter((v): v is string => Boolean(v));
}

function getErrorType(attrs: AttributeSource): string | undefined {
  return getAttr(attrs, ["error.type"]);
}

function truncate(value: unknown, maxLength: number): string | undefined {
  let text: string | undefined;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else if (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === "string"
  ) {
    // OTel multi-value attributes are arrays; render single-element ones.
    text = value[0];
  }

  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

/** Format a display part, same as truncate but exported for tests. */
export function formatDisplayPart(
  value: unknown,
  maxLength: number
): string | undefined {
  return truncate(value, maxLength);
}

/** Deduplicate metadata entries case-insensitively. Values are already truncated by `getAttr`. */
function dedupeMetadata(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v) {
      continue;
    }
    const key = v.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(v);
  }
  return result;
}

/**
 * Merge attribute sources from a raw envelope transaction item.
 * Transaction-level attributes live in `contexts.trace.data`.
 */
export function mergeTransactionAttributes(
  event: Record<string, unknown>
): AttributeSource {
  const contexts = event.contexts as Record<string, unknown> | undefined;
  const trace = contexts?.trace as Record<string, unknown> | undefined;
  const data = trace?.data as Record<string, unknown> | undefined;
  return data ?? {};
}

/**
 * Extract the `data` attribute object from each child span of a transaction.
 *
 * Child span attributes live in `span.data`. The Vercel AI SDK (and other
 * instrumentations that wrap an HTTP handler) attach `gen_ai.*` attributes to
 * child spans rather than the transaction root, so callers that need to detect
 * AI activity must inspect these in addition to the trace-root attributes
 * returned by {@link mergeTransactionAttributes}.
 */
export function collectSpanAttributes(
  event: Record<string, unknown>
): AttributeSource[] {
  const spans = event.spans;
  if (!Array.isArray(spans)) {
    return [];
  }
  const result: AttributeSource[] = [];
  for (const span of spans) {
    const data = (span as Record<string, unknown> | null)?.data;
    if (data && typeof data === "object") {
      result.push(data as AttributeSource);
    }
  }
  return result;
}
