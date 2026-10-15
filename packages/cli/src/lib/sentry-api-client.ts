/**
 * Reusable public API clients, separate from the transport so telemetry's
 * synchronous database imports do not load the ESM-only @sentry/api package.
 */

import { createSentryClient, type SentryClient } from "@sentry/api";
import { getCredentialContext } from "./db/auth.js";
import { getDbPath } from "./db/index.js";
import { getEnv, withEnv } from "./env.js";
import { getSdkConfig } from "./sentry-client.js";

const sentryClients = new WeakMap<
  NodeJS.ProcessEnv,
  Map<string, SentryClient>
>();

/**
 * Reuse one SDK client for this invocation, deployment, and auth context.
 * The transport selects credentials per request so OAuth refresh never
 * leaves the client holding an old access token.
 */
export function getSentryClient(baseUrl: string): SentryClient {
  const env = getEnv();
  let clients = sentryClients.get(env);
  if (!clients) {
    clients = new Map();
    sentryClients.set(env, clients);
  }

  const credential = getCredentialContext();
  const config = getSdkConfig(baseUrl);
  const key = JSON.stringify([
    getDbPath(),
    credential?.identity ?? null,
    credential?.host ?? null,
    config.baseUrl,
  ]);
  const existing = clients.get(key);
  if (existing) {
    return existing;
  }

  const sentry = createSentryClient({
    ...config,
    fetch: (input, init) => withEnv(env, () => config.fetch(input, init)),
  });
  clients.set(key, sentry);
  return sentry;
}
