/**
 * OAuth Types
 *
 * Types and Valibot schemas for OAuth authentication flow (RFC 8628).
 */

import {
  type InferOutput,
  looseObject,
  nullable,
  number,
  optional,
  string,
} from "valibot";

// Device Code Response (Step 1 of Device Flow)

export const DeviceCodeResponseSchema = looseObject({
  device_code: string(),
  user_code: string(),
  verification_uri: string(),
  verification_uri_complete: optional(string()),
  expires_in: number(),
  interval: number(),
});

export type DeviceCodeResponse = InferOutput<typeof DeviceCodeResponseSchema>;

// Token Response (Successful authorization)

export const TokenResponseSchema = looseObject({
  access_token: string(),
  token_type: string(),
  expires_in: number(),
  expires_at: optional(string()),
  refresh_token: optional(string()),
  scope: optional(string()),
  user: optional(
    looseObject({
      id: string(),
      name: nullable(string()),
      email: nullable(string()),
    })
  ),
});

export type TokenResponse = InferOutput<typeof TokenResponseSchema>;

// Token Error Response (OAuth error during polling)

export const TokenErrorResponseSchema = looseObject({
  error: string(),
  error_description: optional(string()),
});

export type TokenErrorResponse = InferOutput<typeof TokenErrorResponseSchema>;
