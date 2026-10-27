/**
 * Response cache policy shared by the CLI and MCP: fallback TTL tiers,
 * identity-scoped keys, and mutation invalidation prefixes. Pure logic with
 * no storage or I/O; each host owns where entries live.
 */

export { computeInvalidationPrefixes } from "./invalidation.js";
export { buildCacheKey, normalizeUrl } from "./keys.js";
export { classifyUrl, FALLBACK_TTL_MS, type TtlTier } from "./tiers.js";
