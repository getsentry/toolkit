import { MastraClientError } from "@mastra/client-js";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../../../src/lib/errors.js";
import { withInitServiceAuthClassification } from "../../../src/lib/init/init-service-auth.js";

const ENDPOINT = "/api/workflows/sentry-wizard/resume-async";

function authFailure(
  code: string,
  safeToRetry = true,
  status = 503
): MastraClientError {
  return new MastraClientError(status, "Service Unavailable", "auth failed", {
    code,
    safeToRetry,
  });
}

describe("withInitServiceAuthClassification", () => {
  test.each([
    "AUTH_UPSTREAM_TIMEOUT",
    "AUTH_UPSTREAM_UNAVAILABLE",
  ])("retries %s once", async (code) => {
    const failure = authFailure(code);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("ok");

    await expect(
      withInitServiceAuthClassification(operation, ENDPOINT)
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("stops after one retry when the auth service remains unavailable", async () => {
    const failure = authFailure("AUTH_UPSTREAM_TIMEOUT");
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(
      withInitServiceAuthClassification(operation, ENDPOINT)
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("classifies a 401 returned by the second attempt", async () => {
    const operation = vi
      .fn<() => Promise<never>>()
      .mockRejectedValueOnce(authFailure("AUTH_UPSTREAM_TIMEOUT"))
      .mockRejectedValueOnce(
        new Error(
          'HTTP error! status: 401 - {"error":"Unauthorized: invalid token"}'
        )
      );

    const error = await withInitServiceAuthClassification(
      operation,
      ENDPOINT
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, endpoint: ENDPOINT });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test.each([
    authFailure("AUTH_UPSTREAM_RATE_LIMITED", false),
    authFailure("UNKNOWN_CODE"),
    authFailure("AUTH_UPSTREAM_TIMEOUT", true, 502),
    new TypeError("fetch failed"),
    Object.assign(new Error("auth failed"), {
      status: 503,
      body: { code: "AUTH_UPSTREAM_TIMEOUT", safeToRetry: true },
    }),
  ])("does not retry an unauthorized failure contract", async (failure) => {
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(
      withInitServiceAuthClassification(operation, ENDPOINT)
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
