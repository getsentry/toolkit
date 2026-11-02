import type { TraceSpan } from "../../../api-client";

interface SemanticSpanDisplay {
  label: string;
  metadata: string[];
}

type SpanDisplayFormatter = (
  span: TraceSpan,
  fallbackLabel: string,
) => SemanticSpanDisplay | null;

const SPAN_LABEL_MAX_LENGTH = 160;
const SPAN_METADATA_MAX_LENGTH = 64;
const SPAN_ATTRIBUTE_MAX_LENGTH = 2048;

const SEMANTIC_SPAN_FORMATTERS: SpanDisplayFormatter[] = [
  formatMcpSpanDisplay,
  formatHttpSpanDisplay,
  formatGenAiSpanDisplay,
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

export function formatSemanticSpanDisplay(
  span: TraceSpan,
): SemanticSpanDisplay {
  const fallbackLabel = formatFallbackSpanLabel(span);
  let display: SemanticSpanDisplay = {
    label: fallbackLabel,
    metadata: [],
  };

  for (const formatter of SEMANTIC_SPAN_FORMATTERS) {
    const semanticDisplay = formatter(span, fallbackLabel);
    if (semanticDisplay) {
      display = semanticDisplay;
      break;
    }
  }

  const label = formatDisplayPart(display.label, SPAN_LABEL_MAX_LENGTH);
  return {
    label: label || "unnamed",
    metadata: formatSemanticMetadata(display.metadata),
  };
}

function formatHttpSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const method = getSpanAttributeString(span, [
    "http.request.method",
  ])?.toUpperCase();
  const statusCode = getSpanAttributeString(span, [
    "http.response.status_code",
  ]);
  const target = getHttpTarget(span, {
    includeServerTarget: Boolean(method || statusCode),
  });
  const errorType = getErrorType(span);

  if (!method && !target && !statusCode) {
    return null;
  }

  const label = formatHttpLabel({ method, target, fallbackLabel });

  return {
    label: label || fallbackLabel,
    metadata: compactStrings([statusCode, errorType]),
  };
}

function formatGenAiSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const operation = getSpanAttributeString(span, ["gen_ai.operation.name"]);
  const toolName = getSpanAttributeString(span, ["gen_ai.tool.name"]);
  const agentName = getSpanAttributeString(span, ["gen_ai.agent.name"]);
  const model = getGenAiModelIdentifier(span);
  const dataSourceId = getSpanAttributeString(span, ["gen_ai.data_source.id"]);
  const errorType = getErrorType(span);

  if (!operation && !toolName && !agentName && !model && !dataSourceId) {
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
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const method = getSpanAttributeString(span, ["mcp.method.name"]);
  const resourceUri = getSpanAttributeString(
    span,
    ["mcp.resource.uri"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );
  const target =
    getSpanAttributeString(span, ["gen_ai.tool.name", "gen_ai.prompt.name"]) ??
    formatResourceTarget(resourceUri);
  const statusCode = getSpanAttributeString(span, ["rpc.response.status_code"]);
  const errorType = getErrorType(span);

  if (!method && !resourceUri) {
    return null;
  }

  return {
    label: joinDisplayParts([method, target]) || fallbackLabel,
    metadata: compactStrings([statusCode, errorType]),
  };
}

function formatDatabaseSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const dbSystem = getSpanAttributeString(span, ["db.system.name"]);
  const querySummary = getSpanAttributeString(span, ["db.query.summary"]);
  const operationName = getSpanAttributeString(span, ["db.operation.name"]);
  const target =
    getSpanAttributeString(span, ["db.collection.name", "db.namespace"]) ??
    getServerTarget(span);
  const storedProcedure = getSpanAttributeString(span, [
    "db.stored_procedure.name",
  ]);
  const queryText = getSpanAttributeString(
    span,
    ["db.query.text"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );

  if (
    !dbSystem &&
    !querySummary &&
    !operationName &&
    !target &&
    !storedProcedure &&
    !queryText
  ) {
    return null;
  }

  const label =
    querySummary ??
    (storedProcedure ? `CALL ${storedProcedure}` : undefined) ??
    (joinDisplayParts([operationName, target]) || undefined) ??
    formatDbQueryText(queryText) ??
    fallbackLabel;
  const statusCode = getSpanAttributeString(span, ["db.response.status_code"]);
  const errorType = getErrorType(span);

  return {
    label,
    metadata: compactStrings([dbSystem, statusCode, errorType]),
  };
}

function formatGraphqlSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const operationType = getSpanAttributeString(span, [
    "graphql.operation.type",
  ]);
  const operationName = getSpanAttributeString(span, [
    "graphql.operation.name",
  ]);
  const document = getSpanAttributeString(
    span,
    ["graphql.document"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );

  if (!operationType && !operationName && !document) {
    return null;
  }

  return {
    label:
      joinDisplayParts([operationType, operationName]) ||
      formatDisplayPart(document, SPAN_LABEL_MAX_LENGTH) ||
      fallbackLabel,
    metadata: [],
  };
}

function formatRpcSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const rpcSystem = getSpanAttributeString(span, ["rpc.system.name"]);
  const service = getSpanAttributeString(span, ["rpc.service"]);
  const method = getSpanAttributeString(span, ["rpc.method"]);
  const statusCode = getSpanAttributeString(span, ["rpc.response.status_code"]);
  const region = getSpanAttributeString(span, ["cloud.region"]);
  const errorType = getErrorType(span);

  if (!rpcSystem && !service && !method && !statusCode) {
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
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const messagingSystem = getSpanAttributeString(span, ["messaging.system"]);
  const operation = getSpanAttributeString(span, [
    "messaging.operation.name",
    "messaging.operation.type",
  ]);
  const destination = getSpanAttributeString(span, [
    "messaging.destination.template",
    "messaging.destination.name",
    "messaging.destination.subscription.name",
  ]);
  const consumerGroup = getSpanAttributeString(span, [
    "messaging.consumer.group.name",
  ]);
  const messageCount = getSpanAttributeString(span, [
    "messaging.batch.message_count",
  ]);
  const errorType = getErrorType(span);

  if (!messagingSystem && !operation && !destination) {
    return null;
  }

  return {
    label: joinDisplayParts([operation, destination]) || fallbackLabel,
    metadata: compactStrings([
      messagingSystem,
      consumerGroup,
      messageCount ? `messages:${messageCount}` : undefined,
      errorType,
    ]),
  };
}

function formatFaasSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const trigger = getSpanAttributeString(span, ["faas.trigger"]);
  const name = getSpanAttributeString(span, ["faas.invoked_name", "faas.name"]);
  const provider = getSpanAttributeString(span, ["faas.invoked_provider"]);
  const region = getSpanAttributeString(span, ["faas.invoked_region"]);
  const coldStart = getSpanAttributeString(span, ["faas.coldstart"]);
  const documentOperation = getSpanAttributeString(span, [
    "faas.document.operation",
  ]);
  const documentTarget = getSpanAttributeString(span, [
    "faas.document.collection",
    "faas.document.name",
  ]);
  const cron = getSpanAttributeString(span, ["faas.cron"]);
  const errorType = getErrorType(span);
  const isColdStart = coldStart === "true";

  if (
    !trigger &&
    !name &&
    !provider &&
    !region &&
    !isColdStart &&
    !documentOperation &&
    !documentTarget &&
    !cron
  ) {
    return null;
  }

  return {
    label:
      joinDisplayParts([
        trigger,
        name,
        joinDisplayParts([documentOperation, documentTarget]) || cron,
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
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const command = getSpanAttributeString(span, [
    "process.executable.name",
    "process.command",
  ]);
  const exitCode = getSpanAttributeString(span, ["process.exit.code"]);
  const errorType = getErrorType(span);

  if (!command && !exitCode) {
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
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const bucket = getSpanAttributeString(span, ["aws.s3.bucket"]);
  const key = getSpanAttributeString(
    span,
    ["aws.s3.key"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );
  const copySource = getSpanAttributeString(
    span,
    ["aws.s3.copy_source"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );
  const operation = getSpanAttributeString(span, ["rpc.method"]);
  const region = getSpanAttributeString(span, ["cloud.region"]);
  const errorType = getErrorType(span);
  const target =
    formatObjectStoreTarget(bucket, key) ??
    formatDisplayPart(copySource, SPAN_LABEL_MAX_LENGTH);

  if (!bucket && !key && !copySource) {
    return null;
  }

  return {
    label: joinDisplayParts([operation, target]) || fallbackLabel,
    metadata: compactStrings([region, errorType]),
  };
}

function formatCloudEventsSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const eventType = getSpanAttributeString(span, ["cloudevents.event_type"]);
  const eventSubject = getSpanAttributeString(span, [
    "cloudevents.event_subject",
  ]);
  const eventSource = getSpanAttributeString(
    span,
    ["cloudevents.event_source"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );
  const specVersion = getSpanAttributeString(span, [
    "cloudevents.event_spec_version",
  ]);

  if (!eventType && !eventSubject && !eventSource && !specVersion) {
    return null;
  }

  return {
    label:
      joinDisplayParts([
        eventType,
        eventSubject ?? formatResourceTarget(eventSource),
      ]) || fallbackLabel,
    metadata: specVersion ? [`cloudevents:${specVersion}`] : [],
  };
}

function formatCicdSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const action = getSpanAttributeString(span, ["cicd.pipeline.action.name"]);
  const pipeline = getSpanAttributeString(span, ["cicd.pipeline.name"]);
  const pipelineResult = getSpanAttributeString(span, ["cicd.pipeline.result"]);
  const taskName = getSpanAttributeString(span, ["cicd.pipeline.task.name"]);
  const taskResult = getSpanAttributeString(span, [
    "cicd.pipeline.task.run.result",
  ]);
  const errorType = getErrorType(span);

  if (!action && !pipeline && !pipelineResult && !taskName && !taskResult) {
    return null;
  }

  return {
    label: joinDisplayParts([action, pipeline]) || taskName || fallbackLabel,
    metadata: compactStrings([pipelineResult, taskResult, errorType]),
  };
}

function formatFeatureFlagSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const flagKey = getSpanAttributeString(span, ["feature_flag.key"]);
  const variant = getSpanAttributeString(span, ["feature_flag.result.variant"]);
  const value = getSpanAttributeString(span, ["feature_flag.result.value"]);
  const provider = getSpanAttributeString(span, ["feature_flag.provider.name"]);
  const reason = getSpanAttributeString(span, ["feature_flag.result.reason"]);
  const errorType = getErrorType(span);

  if (!flagKey && !variant && !value && !provider && !reason) {
    return null;
  }

  return {
    label: joinDisplayParts([flagKey, variant ?? value]) || fallbackLabel,
    metadata: compactStrings([provider, reason, errorType]),
  };
}

function formatExceptionSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const exceptionType = getSpanAttributeString(span, ["exception.type"]);
  const exceptionMessage = getSpanAttributeString(
    span,
    ["exception.message"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );

  if (!exceptionType && !exceptionMessage) {
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

  return {
    label,
    metadata,
  };
}

function formatErrorSpanDisplay(
  span: TraceSpan,
  fallbackLabel: string,
): SemanticSpanDisplay | null {
  const errorType = getErrorType(span);
  if (!errorType) {
    return null;
  }

  return {
    label: fallbackLabel,
    metadata: [errorType],
  };
}

function getGenAiModelIdentifier(span: TraceSpan): string | undefined {
  const provider = getSpanAttributeString(span, ["gen_ai.provider.name"]);
  const model = getSpanAttributeString(span, [
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
  span: TraceSpan,
  { includeServerTarget = false }: { includeServerTarget?: boolean } = {},
): string | undefined {
  const route = getSpanAttributeString(
    span,
    ["http.route", "url.template"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );
  const fullUrl = getSpanAttributeString(
    span,
    ["url.full"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );
  const path = getSpanAttributeString(
    span,
    ["url.path"],
    SPAN_ATTRIBUTE_MAX_LENGTH,
  );
  const serverTarget = getServerTarget(span);

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

  return undefined;
}

function getServerTarget(span: TraceSpan): string | undefined {
  const serverAddress = getSpanAttributeString(span, ["server.address"]);
  const serverPort = getSpanAttributeString(span, ["server.port"]);

  if (!serverAddress) {
    return undefined;
  }

  return formatServerAddress(serverAddress, serverPort);
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
    return joinDisplayParts([method, target]);
  }

  if (target) {
    return target;
  }

  const normalizedFallbackLabel = fallbackLabel.toUpperCase();
  if (
    method &&
    normalizedFallbackLabel !== method &&
    fallbackLabel !== "unnamed"
  ) {
    return normalizedFallbackLabel.startsWith(`${method} `)
      ? fallbackLabel
      : joinDisplayParts([method, fallbackLabel]);
  }

  return method || fallbackLabel;
}

function formatServerAddress(address: string, port?: string): string {
  if (!port || address.includes(":")) {
    return address;
  }

  return `${address}:${port}`;
}

function formatObjectStoreTarget(
  bucket: string | undefined,
  key: string | undefined,
): string | undefined {
  if (bucket && key) {
    return formatDisplayPart(`${bucket}/${key}`, SPAN_LABEL_MAX_LENGTH);
  }

  return bucket ?? formatDisplayPart(key, SPAN_LABEL_MAX_LENGTH);
}

function formatHttpTarget(value: string): string {
  const trimmed = value.trim();

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const withoutFragment = trimmed.split("#", 1)[0];
    return withoutFragment.split("?", 1)[0];
  }

  try {
    const url = new URL(trimmed);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host}${path}`;
  } catch {
    const withoutFragment = trimmed.split("#", 1)[0];
    return withoutFragment.split("?", 1)[0];
  }
}

function formatOperationLabel(
  operation: string,
  subject: string | undefined,
): string {
  if (subject) {
    return `${operation} ${subject}`;
  }

  return operation;
}

function joinDisplayParts(values: Array<string | undefined>): string {
  return compactStrings(values).join(" ");
}

function compactStrings(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function formatDbQueryText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return formatDisplayPart(
    value.replace(/'([^']|'')*'/g, "?").replace(/\b\d+(\.\d+)?\b/g, "?"),
    SPAN_LABEL_MAX_LENGTH,
  );
}

function formatResourceTarget(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return formatDisplayPart(value.split("?", 1)[0], SPAN_LABEL_MAX_LENGTH);
}

function formatFallbackSpanLabel(span: TraceSpan): string {
  return (
    formatDisplayPart(span.name, SPAN_LABEL_MAX_LENGTH) ||
    formatDisplayPart(span.description, SPAN_LABEL_MAX_LENGTH) ||
    formatDisplayPart(span.transaction, SPAN_LABEL_MAX_LENGTH) ||
    "unnamed"
  );
}

function getSpanAttributeString(
  span: TraceSpan,
  keys: string[],
  maxLength = SPAN_METADATA_MAX_LENGTH,
): string | undefined {
  for (const key of keys) {
    for (const source of getSpanAttributeSources(span)) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const value = formatDisplayPart(source[key], maxLength);
        if (value) {
          return value;
        }
      }
    }
  }

  return undefined;
}

function getSpanAttributeSources(span: TraceSpan): Record<string, unknown>[] {
  return [
    toRecord(span.additional_attributes),
    toRecord(span.data),
    toRecord(span.tags),
  ].filter((source): source is Record<string, unknown> => source !== undefined);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function getErrorType(span: TraceSpan): string | undefined {
  return getSpanAttributeString(span, ["error.type"]);
}

function formatSemanticMetadata(values: unknown[]): string[] {
  const metadata: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const displayValue = formatDisplayPart(value, SPAN_METADATA_MAX_LENGTH);
    if (!displayValue) {
      continue;
    }

    const key = displayValue.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    metadata.push(displayValue);
  }

  return metadata;
}

function formatDisplayPart(
  value: unknown,
  maxLength: number,
): string | undefined {
  let text: string | undefined;

  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  }

  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
