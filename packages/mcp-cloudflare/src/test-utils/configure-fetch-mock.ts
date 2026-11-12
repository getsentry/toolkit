import { Response, type V4FetchHandler } from "miniflare";
import { fetch, MockAgent } from "undici";
import { registerFetchMockInterceptors } from "./fetch-mock-setup";

export function createMockOutboundService(): V4FetchHandler {
  const fetchMock = new MockAgent();
  fetchMock.disableNetConnect();
  registerFetchMockInterceptors(fetchMock);
  return async (request) => {
    const response = await fetch(request, { dispatcher: fetchMock });
    return new Response(response.body, response);
  };
}
