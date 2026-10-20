import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  requestDeviceCode,
  pollForToken,
  DeviceCodeError,
} from "./device-code-flow";

const mockDeviceCodeResponse = {
  device_code: "test-device-code",
  user_code: "ABCD-1234",
  verification_uri: "https://sentry.io/oauth/device",
  verification_uri_complete:
    "https://sentry.io/oauth/device?user_code=ABCD-1234",
  interval: 1,
  expires_in: 600,
};

const mockTokenResponse = {
  access_token: "sntrys_test_access_token",
  refresh_token: "sntrys_test_refresh_token",
  token_type: "bearer",
  expires_in: 2592000,
  expires_at: new Date(Date.now() + 2592000 * 1000).toISOString(),
  user: {
    email: "test@example.com",
    id: "12345",
    name: "Test User",
  },
  scope: "org:read project:write team:write event:write",
};

describe("requestDeviceCode", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct request and parses response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockDeviceCodeResponse), { status: 200 }),
    );

    const result = await requestDeviceCode(
      "test-client-id",
      "sentry.io",
      "org:read",
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://sentry.io/oauth/device/code/",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      }),
    );
    expect(result.device_code).toBe("test-device-code");
    expect(result.user_code).toBe("ABCD-1234");
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Bad Request", { status: 400 }),
    );

    await expect(requestDeviceCode("bad-client", "sentry.io")).rejects.toThrow(
      DeviceCodeError,
    );
  });
});

describe("pollForToken", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns token on immediate success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockTokenResponse), { status: 200 }),
    );

    const result = await pollForToken({
      deviceCode: "test-device-code",
      clientId: "test-client-id",
      host: "sentry.io",
      interval: 0.01, // Fast polling for tests
      expiresIn: 10,
    });

    expect(result.access_token).toBe("sntrys_test_access_token");
    expect(result.user.email).toBe("test@example.com");
  });

  it("retries on authorization_pending", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockTokenResponse), { status: 200 }),
      );

    const result = await pollForToken({
      deviceCode: "test-device-code",
      clientId: "test-client-id",
      host: "sentry.io",
      interval: 0.01,
      expiresIn: 10,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.access_token).toBe("sntrys_test_access_token");
  });

  it("throws on access_denied", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "access_denied" }), { status: 400 }),
    );

    await expect(
      pollForToken({
        deviceCode: "test-device-code",
        clientId: "test-client-id",
        host: "sentry.io",
        interval: 0.01,
        expiresIn: 10,
      }),
    ).rejects.toThrow(/Authorization was denied/);
  });

  it("throws on expired_token", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "expired_token" }), { status: 400 }),
    );

    await expect(
      pollForToken({
        deviceCode: "test-device-code",
        clientId: "test-client-id",
        host: "sentry.io",
        interval: 0.01,
        expiresIn: 10,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("reports an unexpected token error without retrying", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      }),
    );

    await expect(
      pollForToken({
        deviceCode: "test-device-code",
        clientId: "test-client-id",
        host: "sentry.io",
        interval: 0.01,
        expiresIn: 10,
      }),
    ).rejects.toMatchObject({
      name: "DeviceCodeError",
      code: "invalid_grant",
      message: "Unexpected error during device code polling: invalid_grant",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("increases interval on slow_down", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockTokenResponse), { status: 200 }),
      );

    const promise = pollForToken({
      deviceCode: "test-device-code",
      clientId: "test-client-id",
      host: "sentry.io",
      interval: 1,
      expiresIn: 30,
    });

    // First poll after 1s interval
    await vi.advanceTimersByTimeAsync(1000);
    // After slow_down, interval becomes 1 + 5 = 6s
    await vi.advanceTimersByTimeAsync(6000);

    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.access_token).toBe("sntrys_test_access_token");
    vi.useRealTimers();
  });
});
