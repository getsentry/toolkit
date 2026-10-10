/**
 * OAuth Schema Tests
 *
 * Validates that Valibot schemas correctly handle real-world API responses,
 * including nullable fields that the Sentry API may return.
 */

import { safeParse } from "valibot";
import { describe, expect, test } from "vitest";
import { TokenResponseSchema } from "../../src/types/oauth.js";

describe("TokenResponseSchema", () => {
  const baseTokenResponse = {
    access_token: "sntrys_abc123",
    refresh_token: "sntryr_def456",
    expires_in: 2_591_999,
    token_type: "Bearer",
    scope: "event:read event:write member:read org:read project:admin",
  };

  test("accepts response with user.name as null (GH-468)", () => {
    const response = {
      ...baseTokenResponse,
      expires_at: "2026-04-18T09:03:59.747189Z",
      user: { id: "48168", name: null, email: "user@example.com" },
    };

    const result = safeParse(TokenResponseSchema, response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.user?.name).toBeNull();
      expect(result.output.user?.email).toBe("user@example.com");
    }
  });

  test("accepts response with user.email as null", () => {
    const response = {
      ...baseTokenResponse,
      user: { id: "48168", name: "Jane Doe", email: null },
    };

    const result = safeParse(TokenResponseSchema, response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.user?.name).toBe("Jane Doe");
      expect(result.output.user?.email).toBeNull();
    }
  });

  test("accepts response with both name and email as null", () => {
    const response = {
      ...baseTokenResponse,
      user: { id: "48168", name: null, email: null },
    };

    const result = safeParse(TokenResponseSchema, response);
    expect(result.success).toBe(true);
  });

  test("accepts response without user field", () => {
    const result = safeParse(TokenResponseSchema, baseTokenResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.user).toBeUndefined();
    }
  });

  test("accepts response with extra fields in user (passthrough)", () => {
    const response = {
      ...baseTokenResponse,
      user: {
        id: "48168",
        name: "Jane",
        email: "jane@example.com",
        avatar_url: "https://example.com/avatar.png",
      },
    };

    const result = safeParse(TokenResponseSchema, response);
    expect(result.success).toBe(true);
  });

  test("rejects response missing access_token", () => {
    const { access_token: _, ...noToken } = baseTokenResponse;
    const result = safeParse(TokenResponseSchema, noToken);
    expect(result.success).toBe(false);
  });
});
