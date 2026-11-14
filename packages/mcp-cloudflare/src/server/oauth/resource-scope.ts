/**
 * Parse RFC 8707 `resource` URLs that scope this MCP deployment to an org/project.
 * Example: https://example.com/mcp/my-org/backend
 */
export function parseResourceMcpConstraints(
  resource: string | null | undefined,
): { organizationSlug: string; projectSlug: string | null } | null {
  if (!resource) {
    return null;
  }

  try {
    const { pathname } = new URL(resource);
    const [root, organizationSlug, projectSlug, ...extraSegments] = pathname
      .split("/")
      .filter(Boolean);

    // Accept only /mcp/:org and /mcp/:org/:project.
    if (
      root !== "mcp" ||
      organizationSlug === undefined ||
      extraSegments.length > 0
    ) {
      return null;
    }

    return { organizationSlug, projectSlug: projectSlug ?? null };
  } catch {
    return null;
  }
}
