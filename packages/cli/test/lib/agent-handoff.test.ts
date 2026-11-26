import { afterEach, describe, expect, test, vi } from "vitest";
import {
  completeAgentHandoff,
  exchangeAgentHandoff,
} from "../../src/lib/agent-handoff.js";
import { markPersistedDefaultUrl } from "../../src/lib/constants.js";
import { getAuthConfig, setAuthToken } from "../../src/lib/db/auth.js";
import { setDefaultUrl } from "../../src/lib/db/defaults.js";
import { formatError } from "../../src/lib/errors.js";
import { setEnv } from "../../src/lib/env.js";
import {
  registerLoginTrustAnchor,
  resetLoginTrustAnchorForTesting,
} from "../../src/lib/token-host.js";
import { at, useTestConfigDir } from "../helpers.js";

const saasHost = "https://sentry.io";
const selfHostedHost = "https://sentry.example.com";
const handoffCode = `sntryh_${"a".repeat(43)}`;
const handoffResponse = (sentryUrl: string, useDeviceAuth = false) =>
  Response.json({
    sentryUrl,
    userEmail: "user@example.com",
    organizationName: "Example Organization",
    organizationSlug: "example-org",
    clientId: "client-id",
    ...(!useDeviceAuth && { setupCode: "private-setup-code" }),
    flowInstructions: "Continue setup.",
  });

describe("agent handoff exchange", () => {
  const getConfigDir = useTestConfigDir("agent-handoff-");
  afterEach(() => {
    resetLoginTrustAnchorForTesting();
    vi.unstubAllGlobals();
    setEnv(process.env);
  });

  test("uses a trusted configured custom host", async () => {
    const env = {
      SENTRY_CUSTOM_HEADERS: "X-IAP-Token: proxy-secret",
      SENTRY_HOST: "sentry.example.com",
    };
    setEnv(env);
    registerLoginTrustAnchor("https://sentry.example.com");
    const fetch = vi
      .fn()
      .mockResolvedValue(handoffResponse("https://sentry.example.com"));
    vi.stubGlobal("fetch", fetch);

    await expect(exchangeAgentHandoff(handoffCode)).resolves.toMatchObject({
      organizationSlug: "example-org",
    });
    const [input, init] = at(fetch.mock.calls, 0);
    const request = new Request(input, init);
    expect(request.url).toBe("https://sentry.example.com/api/0/agent-handoff/");
    expect(request.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("X-IAP-Token")).toBe("proxy-secret");
    await expect(request.json()).resolves.toEqual({
      handoff_code: handoffCode,
    });
  });

  test.each([
    { host: saasHost, email: "user@example.com", accepted: true },
    { host: saasHost, email: "other@example.com", accepted: false },
    { host: selfHostedHost, email: "user@example.com", accepted: true },
  ])(
    "handles device approval for $email on $host",
    async ({ host, email, accepted }) => {
      const selfHosted = host === selfHostedHost;
      setEnv({
        SENTRY_HOST: host,
        SENTRY_CLIENT_ID: "different-client-id",
        SENTRY_CONFIG_DIR: getConfigDir(),
        ...(selfHosted && {
          SENTRY_CUSTOM_HEADERS: "X-IAP-Token: proxy-secret",
        }),
      });
      if (selfHosted) {
        setAuthToken("previous-token", undefined, undefined, {
          host: saasHost,
        });
        setDefaultUrl(host);
      }
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(handoffResponse(host, true))
        .mockResolvedValueOnce(
          Response.json({
            device_code: "private-device-code",
            user_code: "ABCD-EFGH",
            verification_uri: host + "/oauth/device/",
            expires_in: 600,
            interval: 0,
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            access_token: "device-access-token",
            token_type: "bearer",
            expires_in: 3600,
            user: { id: "123", email, name: null },
          }),
        );
      vi.stubGlobal("fetch", fetch);

      const handoff = completeAgentHandoff(handoffCode);
      if (accepted) {
        await expect(handoff).resolves.toMatchObject({
          flowInstructions: "Continue setup.",
        });
        expect(getAuthConfig()?.token).toBe("device-access-token");
      } else {
        await expect(handoff).rejects.toThrow("Sentry handoff sign-in failed.");
        expect(getAuthConfig()?.token).toBeUndefined();
      }

      const [codeUrl, codeInit] = at(fetch.mock.calls, 1);
      const [, tokenInit] = at(fetch.mock.calls, 2);
      expect(codeUrl).toBe(host + "/oauth/device/code/");
      expect(new URLSearchParams(codeInit.body).get("login_hint")).toBe(
        "user@example.com",
      );
      expect(new URLSearchParams(tokenInit.body).get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
      for (const request of [codeInit, tokenInit]) {
        expect(new URLSearchParams(request.body).get("client_id")).toBe(
          "client-id",
        );
        expect(new Headers(request.headers).get("X-IAP-Token")).toBe(
          selfHosted ? "proxy-secret" : null,
        );
        expect(request.redirect).toBe("error");
      }
    },
  );

  test("refuses an untrusted configured custom host", async () => {
    setEnv({ SENTRY_HOST: "sentry.example.com" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(exchangeAgentHandoff(handoffCode)).rejects.toThrow(
      /Refusing to log in against https:\/\/sentry\.example\.com/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("ignores another account's persisted host default", async () => {
    const env = {
      SENTRY_CUSTOM_HEADERS: "X-IAP-Token: proxy-secret",
      SENTRY_URL: "https://sentry.example.com",
    };
    setEnv(env);
    markPersistedDefaultUrl(env.SENTRY_URL);
    const fetch = vi
      .fn()
      .mockResolvedValue(handoffResponse("https://sentry.io"));
    vi.stubGlobal("fetch", fetch);

    await exchangeAgentHandoff(handoffCode);

    const [input, init] = at(fetch.mock.calls, 0);
    const request = new Request(input, init);
    expect(request.url).toBe("https://sentry.io/api/0/agent-handoff/");
    expect(request.headers.get("X-IAP-Token")).toBeNull();
  });

  test.each([
    [400, "Invalid handoff code."],
    [403, "The handoff code was claimed from a different network."],
    [410, "Handoff code unavailable."],
    [429, "Wait 60 seconds, then retry the same handoff code."],
  ])("surfaces useful detail for HTTP %i", async (status, detail) => {
    setEnv({});
    const response = Response.json({ detail }, { status });
    if (status === 429) {
      response.headers.set("Retry-After", "60");
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    let caught: unknown;
    try {
      await exchangeAgentHandoff(handoffCode);
    } catch (error) {
      caught = error;
    }

    expect(formatError(caught)).toContain(detail);
    expect(formatError(caught)).not.toContain(handoffCode);
  });

  test("surfaces structured error detail from the backend", async () => {
    setEnv({});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            detail: {
              code: "agent-handoff-ip-mismatch",
              message:
                'Ask the user to turn off "Use IP pinning" and copy a new handoff prompt.',
              extra: {},
            },
          },
          { status: 403 },
        ),
      ),
    );

    let caught: unknown;
    try {
      await exchangeAgentHandoff(handoffCode);
    } catch (error) {
      caught = error;
    }

    expect(formatError(caught)).toContain(
      'Ask the user to turn off "Use IP pinning" and copy a new handoff prompt.',
    );
    expect(formatError(caught)).not.toContain(handoffCode);
  });

  test("redacts a handoff code from server error detail", async () => {
    setEnv({});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { detail: `Rejected handoff_code=${handoffCode}` },
            { status: 400 },
          ),
        ),
    );

    await expect(exchangeAgentHandoff(handoffCode)).rejects.not.toThrow(
      handoffCode,
    );
  });
});
