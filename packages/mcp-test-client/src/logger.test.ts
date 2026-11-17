import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  logError,
  logSuccess,
  logInfo,
  logUser,
  logTool,
  logToolResult,
  logStreamStart,
  logStreamWrite,
  logStreamEnd,
} from "./logger.js";

describe("Logger", () => {
  let capturedOutput: string;

  beforeEach(() => {
    capturedOutput = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      capturedOutput += chunk;
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("single log functions", () => {
    it("logError without detail", () => {
      logError("Test error");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Test error
        "
      `);
    });

    it("logError with detail", () => {
      logError("Test error", "Error details");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Test error
          ⎿  Error details
        "
      `);
    });

    it("logError with Error object", () => {
      const error = new Error("Something went wrong");
      logError("Test error", error);
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Test error
          ⎿  Something went wrong
        "
      `);
    });

    it("logSuccess without detail", () => {
      logSuccess("Test success");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Test success
        "
      `);
    });

    it("logSuccess with detail", () => {
      logSuccess("Test success", "Success details");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Test success
          ⎿  Success details
        "
      `);
    });

    it("logInfo without detail", () => {
      logInfo("Test info");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Test info
        "
      `);
    });

    it("logInfo with detail", () => {
      logInfo("Test info", "Info details");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Test info
          ⎿  Info details
        "
      `);
    });

    it("logUser", () => {
      logUser("User message");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        > User message
        "
      `);
    });

    it("logTool without params", () => {
      logTool("test_tool");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● test_tool()
        "
      `);
    });

    it("logTool with params", () => {
      logTool("test_tool", { param1: "value1", param2: 42 });
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● test_tool(param1: value1, param2: 42)
        "
      `);
    });

    it("logTool with complex params", () => {
      logTool("test_tool", { obj: { nested: true }, arr: [1, 2, 3] });
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● test_tool(obj: {"nested":true}, arr: [1,2,3])
        "
      `);
    });

    it("logToolResult", () => {
      logToolResult("Tool result");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "  ⎿  Tool result
        "
      `);
    });
  });

  describe("streaming logs", () => {
    it("complete stream flow", () => {
      logStreamStart();
      logStreamWrite("Hello world");
      logStreamWrite(" with continuation");
      logStreamWrite("\nAnd a new line");
      logStreamEnd();

      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Hello world with continuation
          And a new line
        "
      `);
    });

    it("should not start stream twice", () => {
      logStreamStart();
      logStreamStart();
      logStreamWrite("content");
      logStreamEnd();

      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● content
        "
      `);
    });
  });

  describe("multiple consecutive calls", () => {
    it("mixed log types without extra newlines", () => {
      logInfo("First message");
      logSuccess("Second message", "with detail");
      logError("Third message");
      logUser("Fourth message");

      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● First message

        ● Second message
          ⎿  with detail

        ● Third message

        > Fourth message
        "
      `);
    });

    it("tool call sequence", () => {
      logTool("find_issues", { query: "is:unresolved" });
      logToolResult("Found 3 issues");
      logTool("get_issue_details", { issueId: "PROJ-123" });
      logToolResult("Issue details retrieved");

      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● find_issues(query: is:unresolved)
          ⎿  Found 3 issues

        ● get_issue_details(issueId: PROJ-123)
          ⎿  Issue details retrieved
        "
      `);
    });
  });

  describe("real-world scenarios", () => {
    it("authentication flow", () => {
      logInfo("Authenticated with Sentry", "using stored token");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Authenticated with Sentry
          ⎿  using stored token
        "
      `);
    });

    it("interactive mode start", () => {
      logInfo("Interactive mode", "type 'exit', 'quit', or Ctrl+D to end");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Interactive mode
          ⎿  type 'exit', 'quit', or Ctrl+D to end
        "
      `);
    });

    it("MCP connection", () => {
      logSuccess("Connected to MCP server (stdio)", "5 tools available");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Connected to MCP server (stdio)
          ⎿  5 tools available
        "
      `);
    });

    it("fatal error with event ID", () => {
      logError("Fatal error", "Network connection failed. Event ID: abc123");
      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Fatal error
          ⎿  Network connection failed. Event ID: abc123
        "
      `);
    });

    it("complete session simulation", () => {
      // Authentication
      logInfo("Authenticated with Sentry", "using stored token");
      // Connection
      logSuccess("Connected to MCP server (stdio)", "5 tools available");
      // Interactive mode
      logInfo("Interactive mode", "type 'exit', 'quit', or Ctrl+D to end");
      // User query
      logUser(
        "List all my projects and show me details about the most recent issue",
      );

      // AI starts responding (streaming)
      logStreamStart();
      logStreamWrite(
        "I'll help you find your projects and get details about the most recent issue. Let me start by fetching your projects.",
      );
      logStreamEnd();

      // Tool execution mid-response
      logTool("find_projects", { organizationSlug: "my-org" });
      logToolResult("Found 3 projects: frontend-app, backend-api, mobile-app");

      // AI continues response
      logStreamStart();
      logStreamWrite(
        "Great! I found 3 projects. Now let me find the most recent issue across all projects.",
      );
      logStreamEnd();

      // Another tool call mid-response
      logTool("find_issues", {
        query: "is:unresolved",
        sortBy: "last_seen",
        limit: 1,
      });
      logToolResult("Found issue FRONTEND-456: TypeError in checkout flow");

      // AI final response
      logStreamStart();
      logStreamWrite("Here's what I found:\n\n**Your Projects:**");
      logStreamWrite("\n1. frontend-app");
      logStreamWrite("\n2. backend-api");
      logStreamWrite("\n3. mobile-app");
      logStreamWrite("\n\n**Most Recent Issue:**");
      logStreamWrite("\n- FRONTEND-456: TypeError in checkout flow");
      logStreamWrite(
        "\n- This is an unresolved issue in your frontend-app project",
      );
      logStreamEnd();

      // Exit
      logInfo("Goodbye!");

      expect(capturedOutput).toMatchInlineSnapshot(`
        "
        ● Authenticated with Sentry
          ⎿  using stored token

        ● Connected to MCP server (stdio)
          ⎿  5 tools available

        ● Interactive mode
          ⎿  type 'exit', 'quit', or Ctrl+D to end

        > List all my projects and show me details about the most recent issue

        ● I'll help you find your projects and get details about the most recent issue. Let me start by fetching your projects.

        ● find_projects(organizationSlug: my-org)
          ⎿  Found 3 projects: frontend-app, backend-api, mobile-app

        ● Great! I found 3 projects. Now let me find the most recent issue across all projects.

        ● find_issues(query: is:unresolved, sortBy: last_seen, limit: 1)
          ⎿  Found issue FRONTEND-456: TypeError in checkout flow

        ● Here's what I found:
          
          **Your Projects:**
          1. frontend-app
          2. backend-api
          3. mobile-app
          
          **Most Recent Issue:**
          - FRONTEND-456: TypeError in checkout flow
          - This is an unresolved issue in your frontend-app project

        ● Goodbye!
        "
      `);
    });
  });
});
