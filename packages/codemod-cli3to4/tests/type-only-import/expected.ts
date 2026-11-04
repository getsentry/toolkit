import type { SentryOptions as SentryCliOptions } from "sentry";

export function makeOptions(org: string): SentryCliOptions {
  return { org };
}
