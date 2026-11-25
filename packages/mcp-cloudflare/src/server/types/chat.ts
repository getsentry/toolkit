/**
 * Type definitions for Chat API
 */
import { z } from "zod";
import type { UIMessage } from "ai";

// Shared schemas for authentication data across chat routes
export const AuthDataSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.string(),
  token_type: z.string(),
});

export type AuthData = z.infer<typeof AuthDataSchema>;

export const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string(),
  scope: z.string().optional(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

// Error response types
export type ErrorName =
  // 400-level errors (client errors)
  | "MISSING_AUTH_TOKEN"
  | "INVALID_AUTH_DATA"
  | "INVALID_MESSAGES_FORMAT"
  // 401-level errors (authentication)
  | "AUTH_EXPIRED"
  | "AI_AUTH_FAILED"
  | "SENTRY_AUTH_INVALID"
  // 403-level errors (authorization)
  | "INSUFFICIENT_PERMISSIONS"
  // 429-level errors (rate limiting)
  | "RATE_LIMIT_EXCEEDED"
  | "AI_RATE_LIMIT"
  // 500-level errors (server errors)
  | "AI_SERVICE_UNAVAILABLE"
  | "RATE_LIMITER_ERROR"
  | "MCP_CONNECTION_FAILED"
  | "METADATA_FETCH_FAILED"
  | "INTERNAL_ERROR";

export interface ErrorResponse {
  error: string;
  name?: ErrorName;
  eventId?: string;
}

// Request types - uses UIMessage format from AI SDK 6.x (parts-based)
export interface ChatRequest {
  messages: UIMessage[];
}

// MCP types
export type MCPTools = Record<
  string,
  {
    description?: string;
    parameters?: unknown;
  }
>;

// Rate limiter types
export interface RateLimitResult {
  success: boolean;
}
