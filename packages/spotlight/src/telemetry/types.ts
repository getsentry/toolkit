import type {
  EnvelopeItem,
  EventEnvelopeHeaders,
  Measurements,
  SerializedLog,
} from "@sentry/core";

export type TraceId = string;
export type SpanId = string;

export type EventAttachment = {
  header: EnvelopeItem[0];
  data: string;
};

export type FrameVars = {
  [key: string]: string;
};

export type EventFrame = {
  filename?: string;
  abs_path?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  pre_context?: string[];
  post_context?: string[];
  context_line?: string;
  vars?: FrameVars;
  instruction_addr?: string;
  in_app?: boolean;
};

export type EventStacktrace = {
  frames: EventFrame[];
};

export type EventExceptionValue = {
  type: string;
  value: string;
  stacktrace?: EventStacktrace;
};

export type EventException =
  | {
      values: EventExceptionValue[];
      value: undefined;
    }
  | {
      values: undefined;
      value: EventExceptionValue;
    };

export type Breadcrumb = {
  data?: Record<string, unknown>;
  message?: string;
  category: string;
  timestamp: string;
  type: string;
};

export type Context = Record<string, string | number>;

type CommonEventAttrs = {
  // not always present, but we are forcing it in EventCache
  event_id: string;
  timestamp: number;
  message?: SentryFormattedMessage;
  breadcrumbs?: Breadcrumb[] | { values: Breadcrumb[] };
  transaction?: string;
  environment?: string;
  platform?: string;
  server_name?: string;
  release?: string;
  start_timestamp?: number;
  contexts?: Contexts;
  tags?: Tags;
  extra?: Context;
  request?: Record<string, Record<string, string> | string>;
  modules?: Record<string, string>;
  sdk?: Sdk;
  measurements?: Measurements;
  attachments?: EventAttachment[];
  // Inferred source type for distinguishing browser/server/mobile events
  __sourceType?: "browser" | "server" | "mobile";
};

// Note: For some reason the `sentry/core` module doesn't have these additional properties
// in `EventEnvelopeHeaders['trace']` but they are present in the actual events.
// Follow up?
export type TraceContext = EventEnvelopeHeaders["trace"] & {
  span_id?: string;
  status?: string;
  description?: string;
  parent_span_id?: string;
  data?: Record<string, unknown>;
  op?: string;
};

export type FeedbackContext = {
  message: string;
  name?: string;
  contact_email?: string;
  source?: string;
  url?: string;
  associated_event_id?: string;
  replay_id?: string;
};

export type Contexts = {
  runtime?: Context;
  browser?: Context;
  trace?: TraceContext;
  feedback?: FeedbackContext;
} & {
  [key: string]: Context | TraceContext | FeedbackContext | undefined;
};

export type Tags = {
  [key: string]: string;
};

export type SentryFormattedMessage =
  | string
  | {
      formatted: string;
      params?: [];
    };

export type SentryErrorEvent = CommonEventAttrs & {
  type?: "error" | "event" | "message" | "default";
  level?: "fatal" | "error" | "warning" | "info" | "debug";
  exception: EventException;
};

export type Span = {
  trace_id?: TraceId;
  span_id: SpanId;
  parent_span_id?: string | null;
  op?: string | null;
  description?: string | null;
  start_timestamp: number;
  tags?: Tags | null;
  timestamp: number;
  status?: string;
  transaction?: SentryTransactionEvent;
  children?: Span[];
  data?: Record<string, unknown>;
};

export type SentryTransactionEvent = CommonEventAttrs & {
  type: "transaction";
  spans?: Span[];
  start_timestamp: number;
  contexts: Contexts & {
    trace: TraceContext;
  };
};

// Standalone spans are normalized at the envelope boundary. Only segment spans
// are represented as transactions; child spans remain individual spans.
export type SentrySpanEvent = CommonEventAttrs & {
  type: "span";
  span: Span;
  is_segment: boolean;
};

export type ProfileSample = {
  elapsed_since_start_ns: string;
  stack_id: number;
  thread_id: string;
};

export type ProcessedProfileSample = {
  start_timestamp: number;
  stack_id: number;
  thread_id: string;
};

export type SentryProfile = {
  samples: ProfileSample[];
  stacks: number[][];
  frames: EventFrame[];
  platform?: string;
  thread_metadata?: Record<
    string,
    {
      name?: string;
      priority?: number;
    }
  >;
};

export type SentryProcessedProfile = Omit<SentryProfile, "samples"> & {
  samples: ProcessedProfileSample[];
};

export type SentryProfileWithTraceMeta = SentryProcessedProfile & {
  timestamp: number;
  active_thread_id: string;
};

export type SentryDeviceInfo = {
  architecture: string;
  is_emulator?: boolean;
  locale?: string;
  manufacturer?: string;
  model?: string;
};

export type SentryOSInfo = {
  name: string;
  version: string;
  build_number?: string;
};

export type SentryProfileTransactionInfo = {
  name: string;
  id: string;
  trace_id: string;
  active_thread_id: string;
  relative_start_ns?: string;
  relative_end_ns?: string;
};

export type SentryProfileV1Event = CommonEventAttrs & {
  type: "profile";
  device: SentryDeviceInfo;
  os: SentryOSInfo;
  transactions?: Array<SentryProfileTransactionInfo>;
  transaction?: SentryProfileTransactionInfo;
  version: "1";
  profile: SentryProfile;
};

// V2 Profile (Continuous Profiling) Types
export type ProfileV2Sample = {
  timestamp: number; // Unix timestamp in seconds with microseconds precision
  stack_id: number;
  thread_id: string;
};

export type ProfileV2MeasurementValue = {
  timestamp: number;
  value: number;
};

export type ProfileV2Measurement = {
  unit: string;
  values: ProfileV2MeasurementValue[];
};

export type SentryProfileV2 = {
  samples: ProfileV2Sample[];
  stacks: number[][];
  frames: EventFrame[];
  thread_metadata: Record<
    string,
    {
      name?: string;
      priority?: number;
    }
  >;
};

export type SentryProfileV2ChunkEvent = Omit<
  Partial<CommonEventAttrs>,
  "measurements"
> &
  Pick<CommonEventAttrs, "event_id" | "timestamp"> & {
    type: "profile_chunk";
    version: "2";
    profiler_id: string; // Links chunks from same profiler session
    chunk_id: string; // Unique ID for this chunk
    platform: string;
    release?: string;
    environment?: string;
    client_sdk?: {
      name: string;
      version: string;
    };
    debug_meta?: {
      images?: Array<{
        debug_id?: string;
        image_addr?: string;
        type?: string;
        image_size?: number;
        code_file?: string;
      }>;
    };
    measurements?: Record<string, ProfileV2Measurement>;
    profile: SentryProfileV2;
  };

export type SentryLogEventItem = SerializedLog & {
  id: string; // Need to have a unique id for each log
  severity_number: number;
  sdk: string | undefined;
};

export type SentryLogEvent = CommonEventAttrs & {
  type: "log";
  items: Array<SentryLogEventItem>;
};

export type SentryFeedbackEvent = CommonEventAttrs & {
  type: "feedback";
  contexts: Contexts & {
    feedback: FeedbackContext;
  };
};

export type SentryEvent =
  | SentryErrorEvent
  | SentryTransactionEvent
  | SentrySpanEvent
  | SentryProfileV1Event
  | SentryProfileV2ChunkEvent
  | SentryLogEvent
  | SentryFeedbackEvent;

export type Trace = TraceContext & {
  trace_id: string;
  transactions: SentryTransactionEvent[];
  errors: number;
  start_timestamp: number;
  timestamp: number;
  status?: string;
  rootTransaction: SentryTransactionEvent | null;
  rootTransactionName: string;
  spans: Map<string, Span>;
  spanTree: Span[];
  profileGrafted: boolean;
};

export type Sdk = {
  name: string;
  version: string;
  lastSeen: number;
};

export type SentryEventWithPerformanceData = Omit<
  SentryEvent,
  "measurements"
> & {
  measurements: Record<
    string,
    {
      value: number;
      unit: string;
    }
  > & {
    "score.total": {
      value: number;
      unit: string;
    };
    "score.fcp": {
      value: number;
      unit: string;
    };
    "score.lcp": {
      value: number;
      unit: string;
    };
    "score.fid": {
      value: number;
      unit: string;
    };
    "score.cls": {
      value: number;
      unit: string;
    };
    "score.ttfb": {
      value: number;
      unit: string;
    };
    "score.weight.fcp": {
      value: number;
      unit: string;
    };
    "score.weight.lcp": {
      value: number;
      unit: string;
    };
    "score.weight.fid": {
      value: number;
      unit: string;
    };
    "score.weight.cls": {
      value: number;
      unit: string;
    };
    "score.weight.ttfb": {
      value: number;
      unit: string;
    };
  };
};

export type AIToolCall = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown> | string;
  state?: string;
  step?: number;
};

// Content can be string (v1) or array of content blocks (v2)
export type AIContentBlock = {
  type: string;
  text?: string;
};

export type AIMessageContent = string | AIContentBlock[];

export type AIMessage = {
  role: string;
  content: AIMessageContent;
  toolInvocations?: AIToolCall[];
  parts?: unknown[];
};

export type AIPrompt = {
  system?: string;
  messages?: AIMessage[];
};

export type AIResponse = {
  finishReason?: string;
  text?: string;
  toolCalls?: AIToolCall[];
};

export type AIMetadata = {
  modelId?: string;
  modelProvider?: string;
  functionId?: string;
  metadata: Record<string, unknown>;
  maxRetries?: number;
  maxSteps?: number;
  promptTokens?: number;
  completionTokens?: number;
};

export type AITrace = {
  id: string; // root span_id, also used as traceId for display
  name: string; // root span description or op for primary display
  operation: string;
  timestamp: number;
  durationMs: number;
  tokensDisplay: string; // prompt/completion or N/A
  promptTokens?: number;
  completionTokens?: number;
  hasToolCall: boolean;
  rawSpan: Span;
  metadata: AIMetadata;
  prompt?: AIPrompt;
  response?: AIResponse;
  toolCalls: AIToolCall[];
};

export type AILibraryHandler = {
  id: string;
  name: string;
  canHandleSpan: (span: Span) => boolean;
  extractRootSpans: (spans: Span[]) => Span[];
  processTrace: (rootSpan: Span) => AITrace;
  getDisplayTitle: (trace: AITrace) => string;
  getTypeBadge: (trace: AITrace) => string;
  getTokensDisplay: (trace: AITrace) => string;
};
