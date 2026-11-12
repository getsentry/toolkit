import { z } from "zod";

// Sentry OAuth endpoints
export const SENTRY_AUTH_URL = "/oauth/authorize/";
export const SENTRY_TOKEN_URL = "/oauth/token/";

/**
 * OIDC `prompt` values (OIDC Core §3.1.2.1) advertised for `/oauth/authorize`.
 * Each makes Sentry show its consent step, which names the signed-in user and
 * offers Switch account, instead of silently reusing the browser session.
 */
export const SUPPORTED_PROMPT_VALUES = ["consent", "select_account"] as const;

export const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string(), // should be "bearer"
  expires_in: z.number(),
  expires_at: z.string().datetime(),
  user: z.object({
    email: z.string().nullable().optional(),
    id: z.string(),
    name: z.string().nullable(),
  }),
  scope: z.string(),
});
