/** RFC 8628 retry responses. The caller owns the polling deadline and errors. */
export type DevicePollRetry = "authorization_pending" | "slow_down";

/** RFC 8628 section 3.5 requires five additional seconds after slow_down. */
export function nextDevicePollInterval(
  intervalSeconds: number,
  response: DevicePollRetry,
): number {
  return response === "slow_down" ? intervalSeconds + 5 : intervalSeconds;
}

/** RFC 8628 token-poll outcome; callers own deadlines and user-facing errors. */
export type DevicePollOutcome =
  | { status: "retry"; intervalSeconds: number }
  | { status: "denied" | "expired" | "unexpected" };

/** Apply the device-flow retry rules without deciding how to report failure. */
export function advanceDevicePoll(
  intervalSeconds: number,
  errorCode: string | undefined,
): DevicePollOutcome {
  switch (errorCode) {
    case "authorization_pending":
    case "slow_down":
      return {
        status: "retry",
        intervalSeconds: nextDevicePollInterval(intervalSeconds, errorCode),
      };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return { status: "unexpected" };
  }
}
