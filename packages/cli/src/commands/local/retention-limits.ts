/** Shared envelope-count limits for the Local receiver and browser viewer. */
export const DEFAULT_MAX_ENVELOPES = 500;
export const MAX_ENVELOPES = 50_000;
export const LOCAL_RETENTION_EVENT = "sentry.local.retention";

export function isValidMaxEnvelopes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_ENVELOPES
  );
}
