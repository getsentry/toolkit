// Bucket User-Agent into a fixed set of values so it's safe to use as a
// metric attribute (raw UAs are unbounded cardinality). Use this on
// endpoints the MCP client hits directly (/oauth/register, /oauth/token,
// /mcp); on browser-navigated endpoints (/oauth/authorize, /oauth/callback)
// use `resolveClientFamilyFromName` with the DCR-registered client name
// instead.
export function resolveClientFamily(
  userAgent: string | null | undefined,
): string {
  if (!userAgent) return "unknown";

  const ua = userAgent.toLowerCase();

  if (ua.startsWith("claude-code/")) return "claude-code";
  if (ua.startsWith("cursor/")) return "cursor";
  if (ua.startsWith("copilot/")) return "copilot";
  if (ua.startsWith("opencode/")) return "opencode";
  if (ua.startsWith("claude-user")) return "claude";
  if (ua.includes("codex")) return "codex";

  if (ua.startsWith("reactornetty/")) return "reactor-netty";
  if (ua.startsWith("java-http-client/")) return "java-http-client";
  if (ua.startsWith("go-http-client/")) return "go-http-client";
  if (
    ua.startsWith("python-httpx/") ||
    ua.startsWith("python/") ||
    ua.startsWith("aiohttp/")
  ) {
    return "python";
  }
  if (ua.startsWith("bun/")) return "bun";
  if (ua === "node" || ua.startsWith("node-fetch/")) return "node";

  return "other";
}

// Resolver for DCR-registered `client_name` values. Order matters:
// "claude code" must match before "claude".
export function resolveClientFamilyFromName(
  name: string | null | undefined,
): string {
  if (!name) return "unknown";

  const n = name.toLowerCase();

  if (n.includes("claude code") || n.includes("claude-code")) {
    return "claude-code";
  }
  if (n.includes("cursor")) return "cursor";
  if (n.includes("copilot")) return "copilot";
  if (n.includes("codex")) return "codex";
  if (n.includes("opencode")) return "opencode";
  if (n.includes("claude")) return "claude";

  return "other";
}
