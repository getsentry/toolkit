import { claimAgentHandoff, SentryApiError } from "@sentry/api";
import { parseRetryDelayMs } from "@sentry/api/client";
import { vClaimAgentHandoffResponse } from "@sentry/api/valibot";
import {
  type InferOutput,
  looseObject,
  partial,
  safeParse,
  string,
} from "valibot";
import { pointDefaultUrlAtAccount } from "./account-selection.js";
import {
  DEFAULT_SENTRY_URL,
  getConfiguredSentryUrl,
  isPersistedDefaultUrlInEffect,
} from "./constants.js";
import { redactCredentialText } from "./credential-redaction.js";
import { customFetch, warnIfSaasWithEnvCa } from "./custom-ca.js";
import { applyCustomHeaders } from "./custom-headers.js";
import {
  ApiError,
  HostScopeError,
  RateLimitError,
  ValidationError,
} from "./errors.js";
import { getEnv, withEnv } from "./env.js";
import { inheritEnvTokenHost } from "./env-token-host.js";
import { runInteractiveLogin } from "./interactive-login.js";
import {
  buildHostRefusalMessage,
  isAutoLoginHostTrusted,
} from "./login-host-guard.js";
import { normalizeHttpOrigin } from "./sentry-urls.js";
import { bootstrapAuthentication } from "./setup-code.js";
import { registerLoginTrustAnchor } from "./token-host.js";

// Keep this override until @sentry/api ships the optional setupCode contract.
const AgentHandoffResponseSchema = partial(vClaimAgentHandoffResponse, [
  "setupCode",
]);

type AgentHandoffResponse = InferOutput<typeof AgentHandoffResponseSchema>;

const ErrorResponseSchema = looseObject({ detail: string() });

function getExchangeContext(): {
  host: string;
  customHeadersTrusted: boolean;
} {
  const configured = isPersistedDefaultUrlInEffect()
    ? undefined
    : getConfiguredSentryUrl();
  const host = normalizeHttpOrigin(configured ?? DEFAULT_SENTRY_URL);

  if (!host) {
    throw new ApiError(
      "Invalid Sentry URL for agent handoff",
      0,
      "Set SENTRY_HOST or SENTRY_URL to a credential-free HTTP(S) URL.",
    );
  }

  if (!isAutoLoginHostTrusted(host)) {
    throw new HostScopeError(buildHostRefusalMessage(host));
  }

  return { host, customHeadersTrusted: configured !== undefined };
}

function responseDetail(body: unknown): string | undefined {
  if (body instanceof SentryApiError && body.detailMessage) {
    return redactCredentialText(body.detailMessage);
  }

  const errorBody = body instanceof SentryApiError ? body.body : body;
  const parsed = safeParse(ErrorResponseSchema, errorBody);
  return parsed.success
    ? redactCredentialText(parsed.output.detail)
    : undefined;
}

/** Claim a private handoff code from the configured Sentry instance. */
export async function exchangeAgentHandoff(
  handoffCode: string,
): Promise<AgentHandoffResponse> {
  const { host, customHeadersTrusted } = getExchangeContext();
  const headers = new Headers();
  applyCustomHeaders(headers, host, customHeadersTrusted);
  warnIfSaasWithEnvCa(host);

  const result = await claimAgentHandoff({
    baseUrl: host,
    body: { handoff_code: handoffCode },
    fetch: customFetch,
    headers: Object.fromEntries(headers),
    redirect: "error",
  });

  if ("error" in result) {
    const response = result.response;
    if (!response) {
      throw new ApiError(
        "Sentry agent handoff failed",
        0,
        "Check your network connection and try again.",
      );
    }

    const detail = responseDetail(result.error);
    if (response.status === 429) {
      throw new RateLimitError(
        response.url,
        parseRetryDelayMs(response.status, response.headers),
        detail,
      );
    }

    throw new ApiError(
      "Sentry agent handoff failed",
      response.status,
      detail ?? "Request a new handoff from Sentry and try again.",
      response.url || undefined,
    );
  }

  const parsed = safeParse(AgentHandoffResponseSchema, result.data);
  if (!parsed.success) {
    throw new ApiError(
      "Invalid response from the Sentry agent handoff endpoint",
      result.response.status,
      "Request a new handoff from Sentry and try again.",
      result.response.url || undefined,
    );
  }

  return parsed.output;
}

/** Claim a handoff and authenticate its account before returning instructions. */
export async function completeAgentHandoff(
  handoffCode: string,
): Promise<AgentHandoffResponse> {
  const handoff = await exchangeAgentHandoff(handoffCode);

  if (handoff.setupCode !== undefined) {
    await bootstrapAuthentication({
      code: handoff.setupCode,
      clientId: handoff.clientId,
      force: true,
      url: handoff.sentryUrl,
    });
    return handoff;
  }

  const { host } = getExchangeContext();
  if (normalizeHttpOrigin(handoff.sentryUrl) !== host) {
    throw new HostScopeError(
      "The handoff response is for a different Sentry instance.",
    );
  }

  registerLoginTrustAnchor(host);
  const env = {
    ...getEnv(),
    SENTRY_HOST: host,
    SENTRY_URL: host,
    SENTRY_CLIENT_ID: handoff.clientId,
  };
  inheritEnvTokenHost(env);
  const login = await withEnv(env, () =>
    runInteractiveLogin({
      expectedEmail: handoff.userEmail,
      relayDeviceCode: true,
    }),
  );
  if (!login) {
    throw new ValidationError(
      "Sentry handoff sign-in failed. Ask the user to copy a new handoff prompt and try again.",
      "handoff",
    );
  }

  pointDefaultUrlAtAccount(host);
  return handoff;
}
