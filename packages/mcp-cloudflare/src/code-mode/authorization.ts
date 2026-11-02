import { apiServiceForOrganization } from "@sentry/mcp-core/internal/tool-helpers/resolve-region-url";
import type { ServerContext } from "@sentry/mcp-core/types";
import { authorizeApiRequest } from "./access";
import { OPERATIONS } from "./openapi";

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

  /**
   * The URL and headers, Authorization included, for an allowed request.
   * Routing and headers come from the same API service the other tools use.
   */
  async authorize(url: string, method: string): Promise<AuthorizationResult> {
    const target = new URL(url);
    let organizationSlug: string | undefined;
    let pathTemplate: string;
    try {
      ({ organizationSlug, pathTemplate } = authorizeApiRequest(
        target,
        method,
        OPERATIONS,
        { organizationSlug: this.#context.constraints.organizationSlug },
      ));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "API access denied.",
      };
    }
    const { origin, headers } = (
      await apiServiceForOrganization(this.#context, organizationSlug)
    ).requestTarget();
    return {
      url: new URL(`${target.pathname}${target.search}`, origin).toString(),
      headers,
      pathTemplate,
    };
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
