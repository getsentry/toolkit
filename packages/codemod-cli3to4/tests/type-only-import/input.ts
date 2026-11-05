import type { SentryCliOptions } from "@sentry/cli";

export function makeOptions(org: string): SentryCliOptions {
  return { org };
}
