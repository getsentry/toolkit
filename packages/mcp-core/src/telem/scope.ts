import { setAttribute, setTag } from "@sentry/core";

/**
 * Sets `key` on the isolation scope as a tag for error events and as an
 * attribute for streamed spans, logs, and metrics. SDK v11 does not copy
 * scope tags onto spans.
 */
export function setTagAndAttribute(
  key: string,
  value: string | number | boolean,
): void {
  setAttribute(key, value);
  setTag(key, value);
}
