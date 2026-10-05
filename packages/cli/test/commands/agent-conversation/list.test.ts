/**
 * Conversation List Command Tests
 *
 * Tests for the `sentry agent-conversation list` command func() body, covering:
 * - Organization resolution from positional arg
 * - Organization resolution via resolveOrg fallback
 * - Error when org cannot be resolved
 * - Yielding CommandOutput with conversation data
 * - Query filter passthrough
 * - Time params passthrough
 * - Pagination hints with -q flag preserved
 * - Empty result handling
 *
 * Uses spyOn mocking to avoid real HTTP calls or database access.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../src/commands/agent-conversation/list.js";

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

vi.mock("../../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/auth.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbAuth from "../../../src/lib/db/auth.js";
import { ContextError } from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/polling.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/polling.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as polling from "../../../src/lib/polling.js";

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

vi.mock("../../../src/lib/db/pagination.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/pagination.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as paginationDb from "../../../src/lib/db/pagination.js";
import { parsePeriod } from "../../../src/lib/time-range.js";
import type { ConversationListItem } from "../../../src/types/conversation.js";

// ============================================================================
// Helpers
// ============================================================================

const ORG = "test-org";

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd: "/tmp",
    },
    stdoutWrite,
    stderrWrite,
  };
}

/** No-op setMessage callback for withProgress mock */
function noop() {
  // no-op for test
}

/** Passthrough mock for `withProgress` — bypasses spinner, calls fn directly */
function mockWithProgress(
  _opts: unknown,
  fn: (setMessage: () => void) => unknown
) {
  return fn(noop);
}

function makeConversation(
  overrides: Partial<ConversationListItem> = {}
): ConversationListItem {
  return {
    conversationId: "conv-abc-123",
    flow: ["agent"],
    errors: 0,
    llmCalls: 5,
    toolCalls: 3,
    totalTokens: 500,
    totalCost: 0.01,
    startTimestamp: 1_716_500_000,
    endTimestamp: 1_716_500_060,
    traceCount: 1,
    traceIds: ["aaaa1111bbbb2222cccc3333dddd4444"],
    firstInput: "Hello world",
    lastOutput: "Goodbye",
    user: {
      id: "1",
      email: "test@example.com",
      username: "testuser",
      ip_address: null,
    },
    toolNames: ["search"],
    toolErrors: 0,
    ...overrides,
  };
}

const sampleConversations: ConversationListItem[] = [
  makeConversation(),
  makeConversation({
    conversationId: "conv-def-456",
    firstInput: "Second conversation",
    totalTokens: 1200,
  }),
];

const JSON_FLAGS = {
  limit: 25,
  json: true,
  fresh: false,
  period: parsePeriod("7d"),
} as const;

const HUMAN_FLAGS = {
  limit: 25,
  json: false,
  fresh: false,
  period: parsePeriod("7d"),
} as const;

// ============================================================================
// Auth setup
// ============================================================================

let getAuthConfigSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getAuthConfigSpy = vi.spyOn(dbAuth, "getAuthConfig").mockReturnValue({
    token: "sntrys_test",
    source: "oauth" as const,
  });
});

afterEach(() => {
  getAuthConfigSpy.mockRestore();
});

// ============================================================================
// Tests
// ============================================================================

describe("listCommand.func", () => {
  let listConversationsSpy: ReturnType<typeof vi.spyOn>;
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;
  let withProgressSpy: ReturnType<typeof vi.spyOn>;
  let resolveCursorSpy: ReturnType<typeof vi.spyOn>;
  let advancePaginationStateSpy: ReturnType<typeof vi.spyOn>;
  let hasPreviousPageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listConversationsSpy = vi.spyOn(apiClient, "listConversations");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(mockWithProgress);
    resolveCursorSpy = vi.spyOn(paginationDb, "resolveCursor").mockReturnValue({
      cursor: undefined,
      direction: "next" as const,
    });
    advancePaginationStateSpy = vi
      .spyOn(paginationDb, "advancePaginationState")
      .mockReturnValue(undefined);
    hasPreviousPageSpy = vi
      .spyOn(paginationDb, "hasPreviousPage")
      .mockReturnValue(false);
  });

  afterEach(() => {
    listConversationsSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    withProgressSpy.mockRestore();
    resolveCursorSpy.mockRestore();
    advancePaginationStateSpy.mockRestore();
    hasPreviousPageSpy.mockRestore();
  });

  test("resolves org from positional arg", async () => {
    listConversationsSpy.mockResolvedValue({
      data: sampleConversations,
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, ORG);

    // resolveOrg receives the positional org directly
    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: ORG })
    );
    // listConversations called with the resolved org
    expect(listConversationsSpy).toHaveBeenCalledWith(ORG, expect.any(Object));
  });

  test("resolves org via resolveOrg when no positional", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "auto-org" });
    listConversationsSpy.mockResolvedValue({
      data: [],
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, undefined);

    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: undefined })
    );
    expect(listConversationsSpy).toHaveBeenCalledWith(
      "auto-org",
      expect.any(Object)
    );
  });

  test("throws error when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await listCommand.loader();

    await expect(func.call(context, HUMAN_FLAGS, undefined)).rejects.toThrow(
      ContextError
    );
  });

  test("yields CommandOutput with conversation data (JSON)", async () => {
    listConversationsSpy.mockResolvedValue({
      data: sampleConversations,
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, ORG);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("hasMore");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].conversationId).toBe("conv-abc-123");
  });

  test("yields human output with conversation table", async () => {
    listConversationsSpy.mockResolvedValue({
      data: sampleConversations,
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, ORG);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // ID column truncates to terminal width; assert on the surviving prefix.
    expect(output).toContain("conv-");
    expect(output).toContain(ORG);
  });

  test("passes query filter to API", async () => {
    listConversationsSpy.mockResolvedValue({
      data: [],
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { ...JSON_FLAGS, query: "has:errors" }, ORG);

    expect(listConversationsSpy).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ query: "has:errors" })
    );
  });

  test("passes time params to API", async () => {
    listConversationsSpy.mockResolvedValue({
      data: [],
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { ...JSON_FLAGS, period: parsePeriod("24h") },
      ORG
    );

    expect(listConversationsSpy).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ statsPeriod: "24h" })
    );
  });

  test("passes limit to API", async () => {
    listConversationsSpy.mockResolvedValue({
      data: [],
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { ...JSON_FLAGS, limit: 50 }, ORG);

    expect(listConversationsSpy).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ limit: 50 })
    );
  });

  test("returns pagination hints with -q flag preserved", async () => {
    listConversationsSpy.mockResolvedValue({
      data: sampleConversations,
      nextCursor: "next-cursor-abc",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { ...HUMAN_FLAGS, query: "has:errors" }, ORG);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // The hint should include the -q flag for navigation commands
    expect(output).toContain("-c next");
    expect(output).toContain('-q "has:errors"');
  });

  test("handles empty results (human mode)", async () => {
    listConversationsSpy.mockResolvedValue({
      data: [],
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, ORG);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No agent conversations found");
  });

  test("handles empty results with hasMore (page boundary)", async () => {
    listConversationsSpy.mockResolvedValue({
      data: [],
      nextCursor: "some-cursor",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, HUMAN_FLAGS, ORG);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No conversations on this page");
  });

  test("JSON output includes hasMore=true when nextCursor exists", async () => {
    listConversationsSpy.mockResolvedValue({
      data: sampleConversations,
      nextCursor: "cursor-123",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, ORG);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toBe("cursor-123");
  });

  test("JSON output includes hasMore=false when no nextCursor", async () => {
    listConversationsSpy.mockResolvedValue({
      data: sampleConversations,
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, ORG);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.hasMore).toBe(false);
  });

  test("advances pagination state after fetch", async () => {
    listConversationsSpy.mockResolvedValue({
      data: sampleConversations,
      nextCursor: "next-cursor",
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, ORG);

    expect(advancePaginationStateSpy).toHaveBeenCalledWith(
      "agent-conversation-list",
      expect.any(String),
      "next",
      "next-cursor"
    );
  });
});
