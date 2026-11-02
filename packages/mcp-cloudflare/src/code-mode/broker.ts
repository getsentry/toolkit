import { RpcTarget } from "cloudflare:workers";
import { ApiServerError } from "@sentry/mcp-core/api-client";
import { logIssue } from "@sentry/mcp-core/telem/logging";
import type { ApiAuthorization } from "./authorization";
import type { ExecutionGate } from "./execution";
import { configuredUrl, readBoundedBody } from "./http";

export interface BrokerOptions {
  accessToken: string;
  execution: ExecutionGate;
  /** Fixed origin and API prefix, e.g. https://sentry.io/api/0. */
  apiBaseUrl: string;
  allowWrites: boolean;
  authorization: ApiAuthorization;
}

/**
 * One `sentry.request()` as the trusted side saw it. `operation` is the
 * published path template, never the concrete URL; `denied` marks a refusal
 * by this MCP connection's policy rather than by Sentry.
 */
export interface ApiCall {
  method: string;
  operation: string;
  /** HTTP status returned to the sandbox; 408 when execution closed first. */
  status: number;
  /** Whether the request was sent to Sentry. */
  sent: boolean;
  denied?: string;
}

const READ_METHODS = ["GET", "HEAD", "OPTIONS"];

/** The only HTTP capability passed to the sandbox; credentials remain private. */
export class ApiBroker extends RpcTarget {
  #options: BrokerOptions;
  /** Every call this execution made, recorded outside the sandbox for telemetry. */
  readonly calls: ApiCall[] = [];

  constructor(options: BrokerOptions) {
    super();
    this.#options = options;
  }

  async fetch(request: Request): Promise<Response> {
    const call: ApiCall = {
      method: request.method,
      operation: "unknown",
      status: 0,
      sent: false,
    };
    this.calls.push(call);
    try {
      const response = await this.#options.execution.run(() =>
        this.#fetch(request, call),
      );
      call.status = response.status;
      return response;
    } catch (error) {
      if (!this.#options.execution.signal.aborted) throw error;
      call.status = 408;
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

  async #fetch(request: Request, call: ApiCall): Promise<Response> {
    const deny = (detail: string, status = 403) => {
      call.denied = detail;
      return Response.json({ detail }, { status });
    };
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
      return deny(
        "Only the configured Sentry API origin and path prefix are allowed.",
      );
    }
    if (!this.#options.allowWrites && !READ_METHODS.includes(request.method)) {
      return deny("Writes are disabled for this MCP connection.");
    }
    const authorized = await this.#options.authorization.authorize(
      request.url,
      request.method,
    );
    this.#options.execution.assertOpen();
    if ("error" in authorized) return deny(authorized.error);
    call.operation = authorized.pathTemplate;
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
    for (const [name, value] of Object.entries(authorized.headers))
      headers.set(name, value);
    headers.set("Authorization", `Bearer ${this.#options.accessToken}`);
    call.sent = true;
    const response = await fetch(
      new Request(new Request(authorized.url, request), {
        headers,
        redirect: "manual",
        signal: this.#options.execution.signal,
      }),
    );
    if (response.status === 401) {
      await this.#options.authorization.onUnauthorized();
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
              extra: {
                method: request.method,
                status: response.status,
                operation: call.operation,
              },
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

/** Whether a recorded call was sent to Sentry as a write. */
export function isSentWrite(call: ApiCall): boolean {
  return call.sent && !READ_METHODS.includes(call.method);
}
