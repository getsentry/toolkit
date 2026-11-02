import { resolveRegionUrlForOrganization } from "@sentry/mcp-core/internal/tool-helpers/resolve-region-url";
import { validateRegionUrl } from "@sentry/mcp-core/internal/tool-helpers/validate-region-url";
import type { ServerContext } from "@sentry/mcp-core/types";
import { USER_AGENT } from "@sentry/mcp-core/version";
import { authorizeApiRequest } from "./access";
import { getSpec } from "./openapi";

export type AuthorizationResult =
  | { url: string; headers: Record<string, string>; pathTemplate: string }
  | { error: string };

/** Trusted per-request policy, available to the outbound broker, never to user code. */
export class ApiAuthorization {
  #context: ServerContext;
  #unauthorized = false;

  constructor(context: ServerContext) {
    this.#context = context;
  }

  async authorize(url: string, method: string): Promise<AuthorizationResult> {
    const target = new URL(url);
    let organizationSlug: string | undefined;
    let pathTemplate: string;
    try {
      ({ organizationSlug, pathTemplate } = authorizeApiRequest(
        target,
        method,
        getSpec(),
        { organizationSlug: this.#context.constraints.organizationSlug },
      ));
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
    return { url: target.toString(), headers, pathTemplate };
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
