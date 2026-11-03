/**
 * SDK integration stays outside sentry-client: telemetry loads the transport
 * synchronously through database modules, while @sentry/api is ESM-only.
 */
import { createSentryClient, type SentryClient } from "@sentry/api";
import { getSdkConfig, registerSdkResponseBodyMode } from "./sentry-client.js";

let client: SentryClient["client"] | undefined;

/** Share parsing hooks only; credentials, URL and fetch remain per request. */
export function getSdkClientConfig(...args: Parameters<typeof getSdkConfig>) {
  if (!client) {
    client = createSentryClient().client;
    registerSdkResponseBodyMode(client);
  }
  return { ...getSdkConfig(...args), client };
}
