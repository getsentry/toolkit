import type { McpServer } from "@modelcontextprotocol/server";
import { resolveRegionUrlForOrganization } from "@sentry/mcp-core/internal/tool-helpers/resolve-region-url";
import { validateRegionUrl } from "@sentry/mcp-core/internal/tool-helpers/validate-region-url";
import type { Skill } from "@sentry/mcp-core/skills";
import type { ServerContext } from "@sentry/mcp-core/types";
import { USER_AGENT } from "@sentry/mcp-core/version";
import { authorizeApiRequest } from "./access";
import { CODE_MODE_SKILLS } from "./definitions";
import { getSpec, SENTRY_OPENAPI_URL } from "./openapi";
import { registerCodeModeTools } from "./worker";

/** Trusted per-request policy, available to the outbound broker, never to user code. */
export class ApiAuthorization {
  #context: ServerContext;
  #unauthorized = false;

  constructor(context: ServerContext) {
    this.#context = context;
  }

  async authorize(
    url: string,
    method: string,
  ): Promise<
    { url: string; headers: Record<string, string> } | { error: string }
  > {
    const spec = await getSpec(SENTRY_OPENAPI_URL);
    const target = new URL(url);
    let organizationSlug: string | undefined;
    try {
      ({ organizationSlug } = authorizeApiRequest(target, method, spec, {
        organizationSlug: this.#context.constraints.organizationSlug,
      }));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "API access denied.",
      };
    }
    if (organizationSlug) {
      const regionUrl = await resolveRegionUrlForOrganization({
        context: this.#context,
        organizationSlug,
      });
      if (regionUrl) {
        target.host = validateRegionUrl(
          regionUrl,
          this.#context.sentryHost ?? "sentry.io",
        );
        target.protocol = "https:";
      }
    }
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    for (const [field, header] of [
      ["clientId", "X-Sentry-MCP-Client-Id"],
      ["clientName", "X-Sentry-MCP-Client-Name"],
      ["clientFamily", "X-Sentry-MCP-Client-Family"],
      ["utmSource", "X-Sentry-MCP-Utm-Source"],
    ] as const) {
      const value = this.#context[field];
      if (value) headers[header] = value;
    }
    return { url: target.toString(), headers };
  }

  async onUnauthorized(): Promise<void> {
    if (this.#unauthorized) return;
    this.#unauthorized = true;
    try {
      await this.#context.onUpstreamUnauthorized?.();
    } catch {
      // Match the normal tool boundary: revocation failures do not hide the 401.
    }
  }
}

/** Register on the existing authenticated, instrumented MCP server. */
export function registerProductionCodeModeTools(
  server: McpServer,
  loader: WorkerLoader,
  context: ServerContext,
): void {
  const skills = new Set<Skill>(
    [...(context.grantedSkills ?? [])].filter((skill) =>
      CODE_MODE_SKILLS.some((allowedSkill) => skill === allowedSkill),
    ),
  );
  // A project route can mutate shared resources (e.g. release files). OpenAPI
  // does not prove project isolation, so retain the existing scoped tools only.
  if (!skills.size || context.constraints.projectSlug) return;
  const allowWrites = skills.has("api-write");
  registerCodeModeTools(
    server,
    {
      LOADER: loader,
      API_BASE_URL: `${context.sentryProtocol ?? "https"}://${context.sentryHost ?? "sentry.io"}/api/0`,
      OPENAPI_URL: SENTRY_OPENAPI_URL,
      CODE_MODE_ALLOW_WRITES: String(allowWrites),
    },
    context.accessToken,
    new ApiAuthorization(context),
  );
}
