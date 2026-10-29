import { Response, type V4FetchHandler } from "miniflare";
import { fetch, MockAgent } from "undici";
import {
  registerFetchMockInterceptors,
  type FetchMockLike,
} from "./fetch-mock-setup";

export function createMockOutboundService(): V4FetchHandler {
  const fetchMock = new MockAgent();
  fetchMock.disableNetConnect();
  registerFetchMockInterceptors(fetchMock as FetchMockLike);
  return async (request) => {
    const response = await fetch(request, { dispatcher: fetchMock });
    return new Response(response.body, response);
  };
}
