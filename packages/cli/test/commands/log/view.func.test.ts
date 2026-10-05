/**
 * Log View Command Func Tests
 *
 * Tests for the viewCommand func() body in src/commands/log/view.ts.
 * Uses spyOn to mock api-client, resolve-target, and browser to test
 * the func() body without real HTTP calls or database access.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { viewCommand } from "../../../src/commands/log/view.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/browser.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/browser.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../src/lib/browser.js";
import { ContextError, ResolutionError } from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import type { DetailedSentryLog } from "../../../src/types/sentry.js";

const ID1 = "aaaa1111bbbb2222cccc3333dddd4444";
const ID2 = "1111222233334444555566667777aaaa";
const ID3 = "deadbeefdeadbeefdeadbeefdeadbeef";

function makeSampleLog(id: string, message = "Test log"): DetailedSentryLog {
  return {
    "sentry.item_id": id,
    timestamp: "2026-01-30T14:32:15+00:00",
    timestamp_precise: 1_770_060_419_044_800_300,
    message,
    severity: "info",
    trace: "abc123def456abc123def456abc12345",
    project: "test-project",
    environment: "production",
    release: "1.0.0",
    "sdk.name": "sentry.javascript.node",
    "sdk.version": "8.0.0",
    span_id: "span123abc",
    "code.function": "handleRequest",
    "code.file.path": "src/handlers/api.ts",
    "code.line.number": "42",
    "sentry.otel.kind": null,
    "sentry.otel.status_code": null,
    "sentry.otel.instrumentation_scope.name": null,
  };
}

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    stdoutWrite,
  };
}

describe("viewCommand.func", () => {
  let getLogsSpy: ReturnType<typeof spyOn>;
  let getLogItemDetailSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;
  let resolveProjectBoundSlugSpy: ReturnType<typeof spyOn>;
  let openInBrowserSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getLogsSpy = vi.spyOn(apiClient, "getLogs");
    getLogItemDetailSpy = vi.spyOn(apiClient, "getLogItemDetail");
    getLogItemDetailSpy.mockResolvedValue({
      itemId: "",
      timestamp: "",
      attributes: [],
    });
    resolveOrgAndProjectSpy = vi.spyOn(resolveTarget, "resolveOrgAndProject");
    resolveProjectBoundSlugSpy = vi.spyOn(
      resolveTarget,
      "resolveProjectBoundSlug"
    );
    vi.spyOn(resolveTarget, "resolveLogProjectId").mockResolvedValue(1234);
    openInBrowserSpy = vi.spyOn(browser, "openInBrowser");
  });

  afterEach(() => {
    getLogsSpy.mockRestore();
    getLogItemDetailSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
    resolveProjectBoundSlugSpy.mockRestore();
    openInBrowserSpy.mockRestore();
  });

  describe("single log ID", () => {
    test("explicit org/project outputs JSON for a single log", async () => {
      const log = makeSampleLog(ID1);
      getLogsSpy.mockResolvedValue([log]);

      const { context, stdoutWrite } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(context, { json: true, web: false }, "my-org/proj", ID1);

      const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]["sentry.item_id"]).toBe(ID1);
    });

    test("explicit org/project outputs human-readable details", async () => {
      const log = makeSampleLog(ID1, "User login event");
      getLogsSpy.mockResolvedValue([log]);

      const { context, stdoutWrite } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(context, { json: false, web: false }, "my-org/proj", ID1);

      const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain(ID1);
    });

    test("throws ResolutionError when log not found", async () => {
      getLogsSpy.mockResolvedValue([]);

      const { context } = createMockContext();
      const func = await viewCommand.loader();

      try {
        await func.call(
          context,
          { json: false, web: false },
          "my-org/proj",
          ID1
        );
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ResolutionError);
        expect((error as ResolutionError).message).toContain(ID1);
        expect((error as ResolutionError).message).toContain(
          "not found in my-org/proj"
        );
      }
    });
  });

  describe("multiple log IDs", () => {
    test("fetches and outputs multiple logs as JSON", async () => {
      const logs = [makeSampleLog(ID1, "Log 1"), makeSampleLog(ID2, "Log 2")];
      getLogsSpy.mockResolvedValue(logs);

      const { context, stdoutWrite } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(
        context,
        { json: true, web: false },
        "my-org/proj",
        ID1,
        ID2
      );

      const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]["sentry.item_id"]).toBe(ID1);
      expect(parsed[1]["sentry.item_id"]).toBe(ID2);
    });

    test("outputs human-readable details with separators", async () => {
      const logs = [makeSampleLog(ID1, "Log 1"), makeSampleLog(ID2, "Log 2")];
      getLogsSpy.mockResolvedValue(logs);

      const { context, stdoutWrite } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(
        context,
        { json: false, web: false },
        "my-org/proj",
        ID1,
        ID2
      );

      const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain(ID1);
      expect(output).toContain(ID2);
      expect(output).toContain("---");
    });

    test("splits newline-separated IDs in a single argument", async () => {
      const logs = [makeSampleLog(ID1), makeSampleLog(ID2)];
      getLogsSpy.mockResolvedValue(logs);

      const combined = `${ID1}\n${ID2}`;
      const { context, stdoutWrite } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(
        context,
        { json: true, web: false },
        "my-org/proj",
        combined
      );

      // getLogs should have been called with both IDs
      expect(getLogsSpy).toHaveBeenCalledWith("my-org", "proj", [ID1, ID2], {
        extraFields: undefined,
        projectId: 1234,
      });

      const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
    });

    test("still outputs found logs when some IDs are missing", async () => {
      // Only ID1 found, ID2 and ID3 missing — warning goes through consola
      getLogsSpy.mockResolvedValue([makeSampleLog(ID1)]);

      const { context, stdoutWrite } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(
        context,
        { json: true, web: false },
        "my-org/proj",
        ID1,
        ID2,
        ID3
      );

      // Should still output the found log as JSON
      const stdoutOutput = stdoutWrite.mock.calls.map((c) => c[0]).join("");
      const parsed = JSON.parse(stdoutOutput);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]["sentry.item_id"]).toBe(ID1);
    });

    test("throws ResolutionError when no logs found for multiple IDs", async () => {
      getLogsSpy.mockResolvedValue([]);

      const { context } = createMockContext();
      const func = await viewCommand.loader();

      try {
        await func.call(
          context,
          { json: false, web: false },
          "my-org/proj",
          ID1,
          ID2
        );
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ResolutionError);
        const msg = (error as ResolutionError).message;
        expect(msg).toContain("not found in my-org/proj");
        // Each ID should appear in the suggestions
        expect(msg).toContain(ID1);
        expect(msg).toContain(ID2);
      }
    });
  });

  describe("--web flag", () => {
    test("opens browser for single log ID", async () => {
      openInBrowserSpy.mockResolvedValue(undefined);

      const { context } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(context, { json: false, web: true }, "my-org/proj", ID1);

      expect(openInBrowserSpy).toHaveBeenCalled();
      const url = openInBrowserSpy.mock.calls[0][0] as string;
      expect(url).toContain(ID1);
      // Should NOT fetch logs when using --web
      expect(getLogsSpy).not.toHaveBeenCalled();
    });

    test("refuses to open multiple tabs in non-interactive mode", async () => {
      openInBrowserSpy.mockResolvedValue(undefined);

      const { context } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(
        context,
        { json: false, web: true },
        "my-org/proj",
        ID1,
        ID2
      );

      // Non-interactive (no TTY in tests) — should warn and not open any tabs
      expect(openInBrowserSpy).not.toHaveBeenCalled();
    });
  });

  describe("target resolution", () => {
    test("project-search resolves and fetches logs", async () => {
      resolveProjectBoundSlugSpy.mockResolvedValue({
        org: "resolved-org",
        project: "resolved-proj",
      });
      getLogsSpy.mockResolvedValue([makeSampleLog(ID1)]);

      const { context } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(context, { json: true, web: false }, "my-project", ID1);

      expect(resolveProjectBoundSlugSpy).toHaveBeenCalled();
      expect(getLogsSpy).toHaveBeenCalledWith(
        "resolved-org",
        "resolved-proj",
        [ID1],
        { extraFields: undefined, projectId: 1234 }
      );
    });

    test("org/ target (org-all) throws ContextError", async () => {
      const { context } = createMockContext();
      const func = await viewCommand.loader();

      try {
        await func.call(context, { json: false, web: false }, "my-org/", ID1);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        expect((error as ContextError).message).toContain("Specific project");
      }
    });

    test("auto-detect resolves org/project and fetches logs", async () => {
      resolveOrgAndProjectSpy.mockResolvedValue({
        org: "detected-org",
        project: "detected-proj",
        detectedFrom: ".env file",
      });
      getLogsSpy.mockResolvedValue([makeSampleLog(ID1)]);

      const { context, stdoutWrite } = createMockContext();
      const func = await viewCommand.loader();
      // No target arg — triggers auto-detect
      await func.call(context, { json: false, web: false }, ID1);

      expect(resolveOrgAndProjectSpy).toHaveBeenCalled();
      expect(getLogsSpy).toHaveBeenCalledWith(
        "detected-org",
        "detected-proj",
        [ID1],
        { extraFields: undefined, projectId: 1234 }
      );

      // Human output should include the detected-from hint
      const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain("Detected from .env file");
    });

    test("throws ContextError when auto-detect returns null", async () => {
      resolveOrgAndProjectSpy.mockResolvedValue(null);

      const { context } = createMockContext();
      const func = await viewCommand.loader();

      try {
        await func.call(context, { json: false, web: false }, ID1);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        expect((error as ContextError).message).toContain(
          "organization and project"
        );
      }
    });
  });

  describe("detail attribute fetching", () => {
    test("calls getLogItemDetail for logs that have a trace", async () => {
      const log = makeSampleLog(ID1); // makeSampleLog sets trace: "abc123..."
      getLogsSpy.mockResolvedValue([log]);

      const { context } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(context, { json: false, web: false }, "my-org/proj", ID1);

      expect(getLogItemDetailSpy).toHaveBeenCalledWith(
        "my-org",
        "proj",
        ID1,
        log.trace
      );
    });

    test("does not call getLogItemDetail for logs without a trace", async () => {
      const log = makeSampleLog(ID1, "no trace log");
      log.trace = null;
      getLogsSpy.mockResolvedValue([log]);

      const { context } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(context, { json: false, web: false }, "my-org/proj", ID1);

      expect(getLogItemDetailSpy).not.toHaveBeenCalled();
    });

    test("still renders output when getLogItemDetail fails", async () => {
      const log = makeSampleLog(ID1);
      getLogsSpy.mockResolvedValue([log]);
      getLogItemDetailSpy.mockRejectedValue(new Error("network error"));

      const { context, stdoutWrite } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(context, { json: false, web: false }, "my-org/proj", ID1);

      // Should still render the log with standard fields despite detail failure
      const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain(ID1);
    });

    test("does not call getLogItemDetail in JSON mode", async () => {
      const log = makeSampleLog(ID1);
      getLogsSpy.mockResolvedValue([log]);

      const { context } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(context, { json: true, web: false }, "my-org/proj", ID1);

      expect(getLogItemDetailSpy).not.toHaveBeenCalled();
    });

    test("renders custom attributes in human output when detail available", async () => {
      const log = makeSampleLog(ID1);
      getLogsSpy.mockResolvedValue([log]);
      getLogItemDetailSpy.mockResolvedValue({
        itemId: ID1,
        timestamp: log.timestamp,
        attributes: [
          { name: "user.id", type: "str", value: "u_42" },
          { name: "order.status", type: "str", value: "shipped" },
        ],
      });

      const { context, stdoutWrite } = createMockContext();
      const func = await viewCommand.loader();
      await func.call(context, { json: false, web: false }, "my-org/proj", ID1);

      const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain("Custom Attributes");
      expect(output).toContain("user.id");
      expect(output).toContain("u_42");
      expect(output).toContain("order.status");
      expect(output).toContain("shipped");
    });
  });
});
