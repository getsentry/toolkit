/** Test helpers for endpoint wrappers: a core whose transport is scripted. */

import { vi } from "vitest";
import { type ApiTarget, createApiClientCore } from "../api-client/core.js";

export const ORIGIN = "https://us.sentry.io";

export function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A `Link` header with a next page at `cursor` for the API `path`. */
export function nextLink(path: string, cursor: string) {
  return {
    link: `<${ORIGIN}/api/0${path}?cursor=${cursor}>; rel="next"; results="true"; cursor="${cursor}"`,
  };
}

/** A target whose transport answers each request with the next response. */
export function scriptedTarget(...responses: Response[]) {
  const request = vi.fn(async (_url: string, _init: RequestInit) => {
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected request");
    }
    return response;
  });
  const core = createApiClientCore({
    transport: { request },
    headers: () => ({}),
    logger: { warn: vi.fn() },
  });
  const apiTarget: ApiTarget = { core, origin: ORIGIN };
  return { apiTarget, request };
}
