import { RpcTarget } from "cloudflare:workers";
import { ApiServerError } from "@sentry/mcp-core/api-client";
import { logIssue } from "@sentry/mcp-core/telem/logging";
import type { ExecutionGate } from "./execution";
import { configuredUrl, readBoundedBody } from "./http";
import type { ApiAuthorization } from "./production";

export interface CodeModeEnv {
  LOADER: WorkerLoader;
  /** Fixed origin and API prefix, e.g. https://sentry.io/api/0. */
  API_BASE_URL: string;
  /** Trusted, pre-dereferenced OpenAPI JSON source; never supplied by the model. */
  OPENAPI_URL: string;
  CODE_MODE_ALLOW_WRITES?: string;
}

export interface BrokerOptions {
  accessToken: string;
  execution: ExecutionGate;
  apiBaseUrl: string;
  allowWrites: boolean;
  authorization?: ApiAuthorization;
}

/** The only HTTP capability passed to the sandbox; credentials remain private. */
export class ApiBroker extends RpcTarget {
  #options: BrokerOptions;

  constructor(options: BrokerOptions) {
    super();
    this.#options = options;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.#options.execution.run(() => this.#fetch(request));
    } catch (error) {
      if (!this.#options.execution.signal.aborted) throw error;
      // Settle RPC with a value, even when the sandbox no longer awaits it.
      return Response.json(
        {
          detail:
            error instanceof Error
              ? error.message
              : "Code execution has finished.",
        },
        { status: 408 },
      );
    }
  }

  async #fetch(request: Request): Promise<Response> {
    const base = configuredUrl(this.#options.apiBaseUrl);
    const requested = new URL(request.url);
    const prefix = base.pathname.replace(/\/$/, "");
    if (
      requested.origin !== base.origin ||
      requested.username ||
      requested.password ||
      (requested.pathname !== prefix &&
        !requested.pathname.startsWith(`${prefix}/`)) ||
      /%2f|%5c/i.test(requested.pathname)
    ) {
      return Response.json(
        {
          detail:
            "Only the configured Sentry API origin and path prefix are allowed.",
        },
        { status: 403 },
      );
    }
    if (
      !this.#options.allowWrites &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      return Response.json(
        { detail: "Writes are disabled for this MCP connection." },
        { status: 403 },
      );
    }
    let destination = requested.toString();
    let attribution: Record<string, string> = {};
    if (this.#options.authorization) {
      const authorized = await this.#options.authorization.authorize(
        request.url,
        request.method,
      );
      this.#options.execution.assertOpen();
      if ("error" in authorized) {
        return Response.json({ detail: authorized.error }, { status: 403 });
      }
      destination = authorized.url;
      attribution = authorized.headers;
    }
    this.#options.execution.assertOpen();
    // Only API-relevant input headers cross the boundary. Auth is always replaced.
    const headers = new Headers();
    for (const name of [
      "accept",
      "content-type",
      "if-match",
      "if-none-match",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(attribution))
      headers.set(name, value);
    headers.set("Authorization", `Bearer ${this.#options.accessToken}`);
    const response = await fetch(
      new Request(new Request(destination, request), {
        headers,
        redirect: "manual",
        signal: this.#options.execution.signal,
      }),
    );
    if (response.status === 401) {
      await this.#options.authorization?.onUnauthorized();
    }
    // Report before returning to user code, which may handle the HTTP error.
    const eventId =
      response.status >= 500
        ? logIssue(
            new ApiServerError(
              "Sentry API request failed during Code Mode execution.",
              response.status,
            ),
            {
              loggerScope: ["code-mode", "api"],
              extra: { method: request.method, status: response.status },
            },
          )
        : undefined;
    // Do not allow a redirect to carry our bearer token to another location.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return Response.json(
        {
          detail:
            "API redirects are not followed. Use the canonical endpoint path.",
        },
        { status: 502 },
      );
    }
    const responseHeaders = new Headers();
    if (eventId) responseHeaders.set("x-sentry-event-id", eventId);
    for (const name of [
      "content-type",
      "link",
      "retry-after",
      "www-authenticate",
      "x-sentry-rate-limits",
      "etag",
    ]) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    const body = await readBoundedBody(response.body, 2_000_000);
    return new Response(
      [204, 205, 304].includes(response.status) || request.method === "HEAD"
        ? null
        : body,
      {
        status: response.status,
        headers: responseHeaders,
      },
    );
  }
}
