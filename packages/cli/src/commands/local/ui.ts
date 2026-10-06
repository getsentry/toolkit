import { openBrowser } from "../../lib/browser.js";
import { getCliEnvironment } from "../../lib/constants.js";
import { ValidationError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

const DEVELOPMENT_UI_URL = "http://localhost:5173";
const PRODUCTION_UI_URL = "https://local.sentry.dev";

function normalizeHostname(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Whether a host is safe for the browser-only local UI connection. */
export function isLoopbackHost(host: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(normalizeHostname(host));
}

/** Reject a host that the browser-only UI cannot safely reach. */
export function assertLoopbackHostForUi(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new ValidationError(
      "--open requires a loopback --host (localhost, 127.0.0.1, or ::1).",
      "host"
    );
  }
}

/** Validate an --open host before the caller creates or attaches a receiver. */
export function validateOpenHost(requested: boolean, host: string): void {
  if (requested) {
    assertLoopbackHostForUi(host);
  }
}

/** Format an HTTP origin, including the brackets required for IPv6 URLs. */
export function formatLocalServerUrl(host: string, port: number): string {
  const normalized = normalizeHostname(host);
  const urlHost = normalized.includes(":") ? `[${normalized}]` : normalized;
  return `http://${urlHost}:${port}`;
}

/** Pick the independently served local UI URL for this CLI build. */
export function getLocalUiBaseUrl(
  environment: string = getCliEnvironment()
): string {
  return environment === "development" ? DEVELOPMENT_UI_URL : PRODUCTION_UI_URL;
}

/** Build the browser URL without exposing the local stream to the UI host. */
export function buildLocalUiUrl(receiverUrl: string): string {
  const receiver = new URL(receiverUrl);
  assertLoopbackHostForUi(receiver.hostname);

  const streamUrl = new URL("/stream", receiver).toString();
  const uiUrl = new URL(getLocalUiBaseUrl());
  uiUrl.hash = new URLSearchParams({ stream: streamUrl }).toString();
  return uiUrl.toString();
}

/** Open the independently served local UI without affecting capture on failure. */
export async function openLocalUi(receiverUrl: string): Promise<void> {
  const uiUrl = buildLocalUiUrl(receiverUrl);
  let opened = false;
  try {
    opened = await openBrowser(uiUrl);
  } catch (error) {
    logger.debug("Could not open Sentry Local UI", error);
  }
  if (opened) {
    logger.info("Opening Sentry Local UI...");
    return;
  }
  logger.warn(`Could not open browser. Visit ${uiUrl}`);
}

/** Launch the UI only when the caller explicitly requested it. */
export async function openLocalUiIfRequested(
  requested: boolean,
  receiverUrl: string
): Promise<void> {
  if (requested) {
    await openLocalUi(receiverUrl);
  }
}
