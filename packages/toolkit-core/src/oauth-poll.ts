/** RFC 8628 retry responses. The caller owns the polling deadline and errors. */
export type DevicePollRetry = "authorization_pending" | "slow_down";

/** RFC 8628 section 3.5 requires five additional seconds after slow_down. */
export function nextDevicePollInterval(
  intervalSeconds: number,
  response: DevicePollRetry,
): number {
  return response === "slow_down" ? intervalSeconds + 5 : intervalSeconds;
}
