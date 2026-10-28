export const RAW_TYPES = new Set(["attachment", "replay_video", "statsd"]);
export const ERROR_EVENT_TYPES = new Set(["event", "error"]);
export const TRACE_EVENT_TYPES = new Set(["transaction"]);
export const PROFILE_EVENT_TYPES = new Set(["profile", "profile_chunk"]);
export const LOG_EVENT_TYPES = new Set(["log"]);
export const FEEDBACK_EVENT_TYPES = new Set(["feedback"]);
export const ATTACHMENT_EVENT_TYPES = new Set(["attachment"]);
export const SUPPORTED_EVENT_TYPES = new Set([
  ...ERROR_EVENT_TYPES,
  ...TRACE_EVENT_TYPES,
  ...PROFILE_EVENT_TYPES,
  ...LOG_EVENT_TYPES,
  ...FEEDBACK_EVENT_TYPES,
]);
