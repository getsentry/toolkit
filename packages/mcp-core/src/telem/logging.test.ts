import { assert, describe, expect, it, vi, afterEach } from "vitest";

describe("logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("routes structured info logs to stderr instead of stdout", async () => {
    vi.resetModules();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { logInfo } = await import("./logging");

    logInfo("No issues found for query: is:unresolved", {
      extra: {
        query: "is:unresolved",
        organizationSlug: "org",
      },
    });

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);

    const [call] = error.mock.calls;
    assert(call, "console.error was not called");
    const [payload] = call;
    expect(typeof payload).toBe("string");
    expect(JSON.parse(payload as string)).toMatchObject({
      level: "INFO",
      message: "No issues found for query: is:unresolved",
      logger: "sentry.mcp",
      properties: {
        severity: "info",
        query: "is:unresolved",
        organizationSlug: "org",
      },
    });
  });

  it("preserves issue contexts, attachments, and logger scope", async () => {
    vi.resetModules();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { logIssue } = await import("./logging");

    logIssue(new Error("issue failed"), {
      contexts: {
        request: { requestId: "request-123" },
      },
      attachments: {
        "details.txt": "details",
      },
      loggerScope: ["tests", "issues"],
    });

    expect(error).toHaveBeenCalledTimes(1);
    const [call] = error.mock.calls;
    assert(call, "console.error was not called");
    const [payload] = call;
    expect(JSON.parse(payload as string)).toMatchObject({
      level: "ERROR",
      message: "issue failed",
      logger: "sentry.mcp.tests.issues",
      properties: {
        attachments: ["details.txt"],
        sentryContexts: {
          request: { requestId: "request-123" },
        },
      },
    });
  });
});
