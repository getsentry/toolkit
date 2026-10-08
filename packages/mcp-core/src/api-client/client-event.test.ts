import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testEvents } from "../internal/test-fixtures";
import { SentryApiService } from "./client";
import { ApiValidationError } from "./errors";

const request = {
  organizationSlug: "test-org",
  issueId: "123",
  eventId: "latest",
};

function respondWith(context: unknown, overrides = {}) {
  mswServer.use(
    http.get(
      "https://sentry.io/api/0/organizations/test-org/issues/123/events/latest/",
      () =>
        HttpResponse.json({
          ...testEvents.pythonException("Invalid value"),
          context,
          ...overrides,
        }),
    ),
  );
}

describe("getEventForIssue context validation", () => {
  const client = new SentryApiService({ accessToken: "test-token" });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { context: ["private-extra-value"], contextType: "array" },
    { context: "private-extra-value", contextType: "string" },
    { context: 12345, contextType: "number" },
    { context: false, contextType: "boolean" },
    // Valid context can accompany a failure in another field.
    { context: null, contextType: "null", title: null },
    { context: undefined, contextType: "undefined", title: null },
    {
      context: { "private-extra-key": "private-extra-value" },
      contextType: "object",
      title: null,
    },
  ])(
    "logs $contextType on validation failure without exposing extra data",
    async ({ context, contextType, ...overrides }) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      respondWith(context, overrides);

      await expect(client.getEventForIssue(request)).rejects.toBeInstanceOf(
        ApiValidationError,
      );

      expect(log).toHaveBeenCalledTimes(1);
      const output = String(log.mock.calls[0][0]);
      const record = JSON.parse(output);
      expect(record.message).toBe("Event failed schema validation: error");
      expect(record.properties.contextType).toBe(contextType);
      expect(record.properties).not.toHaveProperty("context");
      expect(output).not.toContain("private-extra-key");
      expect(output).not.toContain("private-extra-value");
    },
  );

  it.each([
    undefined,
    null,
    {},
    { array: [1, "two"], nested: { value: false }, nullable: null },
  ])("preserves valid context: %j", async (context) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(context);

    const event = await client.getEventForIssue(request);
    expect(event.context).toEqual(context);
    expect(log).not.toHaveBeenCalled();
  });
});
