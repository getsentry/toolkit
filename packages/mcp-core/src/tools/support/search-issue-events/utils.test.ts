import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { SentryApiService } from "../../../api-client";
import { createIssueEventFieldsTool } from "./utils";

describe("createIssueEventFieldsTool", () => {
  it("lists the project's custom tags, not feature flags", async () => {
    const requests: URLSearchParams[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/test-org/tags/",
        ({ request }) => {
          const params = new URL(request.url).searchParams;
          requests.push(params);
          // useFlagsBackend=1 makes Sentry return feature flag keys instead
          // of tags, which left custom tags such as sessionId out of the list.
          if (params.get("useFlagsBackend") === "1") {
            return HttpResponse.json([]);
          }
          return HttpResponse.json([
            { key: "sessionId", name: "sessionId", totalValues: 12 },
          ]);
        },
      ),
    );

    const tool = createIssueEventFieldsTool({
      apiService: new SentryApiService({ accessToken: "test-token" }),
      organizationSlug: "test-org",
      projectId: "123",
    });
    const output = await tool.execute!(
      {},
      { toolCallId: "issue-event-fields-test", messages: [] },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].get("dataset")).toBe("events");
    expect(requests[0].get("project")).toBe("123");
    expect(requests[0].has("useFlagsBackend")).toBe(false);
    expect(output).toEqual({
      result: expect.stringMatching(
        /Project-Specific Tags \(from API\):\n- sessionId: sessionId\n/,
      ),
    });
  });
});
