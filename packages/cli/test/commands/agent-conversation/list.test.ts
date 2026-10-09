/**
 * Conversation List Command Tests
 *
 * Tests for the `sentry agent-conversation list` command func() body, covering:
 * - Organization and project target resolution
 * - Organization auto-detection
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
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/db/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/auth.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as dbAuth from "../../../src/lib/db/auth.js";

vi.mock("../../../src/lib/polling.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/polling.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as polling from "../../../src/lib/polling.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

vi.mock("../../../src/lib/db/pagination.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/pagination.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as paginationDb from "../../../src/lib/db/pagination.js";
import { parsePeriod } from "../../../src/lib/time-range.js";
import type { ConversationListItem } from "../../../src/types/conversation.js";

// ============================================================================
// Helpers
// ============================================================================

const ORG = "test-org";
const PROJECT = { id: "42", slug: "backend", name: "Backend" };

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
  fn: (setMessage: () => void) => unknown,
) {
  return fn(noop);
}

function makeConversation(
  overrides: Partial<ConversationListItem> = {},
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
  let getProjectSpy: ReturnType<typeof vi.spyOn>;
  let listConversationsSpy: ReturnType<typeof vi.spyOn>;
  let resolveTargetSpy: ReturnType<typeof vi.spyOn>;
  let withProgressSpy: ReturnType<typeof vi.spyOn>;
  let resolveCursorSpy: ReturnType<typeof vi.spyOn>;
  let advancePaginationStateSpy: ReturnType<typeof vi.spyOn>;
  let hasPreviousPageSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getProjectSpy = vi.spyOn(apiClient, "getProject");
    listConversationsSpy = vi.spyOn(apiClient, "listConversations");
    resolveTargetSpy = vi
      .spyOn(resolveTarget, "resolveOrgOptionalFromArg")
      .mockResolvedValue({ org: ORG });
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
    getProjectSpy.mockRestore();
    listConversationsSpy.mockRestore();
    resolveTargetSpy.mockRestore();
    withProgressSpy.mockRestore();
    resolveCursorSpy.mockRestore();
    advancePaginationStateSpy.mockRestore();
    hasPreviousPageSpy.mockRestore();
  });

  test("resolves explicit organization scope", async () => {
    listConversationsSpy.mockResolvedValue({
      data: sampleConversations,
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, `${ORG}/`);

    expect(resolveTargetSpy).toHaveBeenCalledWith(
      `${ORG}/`,
      "/tmp",
      "agent-conversation list",
    );
    expect(listConversationsSpy).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ project: undefined }),
    );
  });

  test("auto-detects organization when target is omitted", async () => {
    resolveTargetSpy.mockResolvedValue({ org: "auto-org" });
    listConversationsSpy.mockResolvedValue({
      data: [],
      nextCursor: undefined,
    });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, undefined);

    expect(resolveTargetSpy).toHaveBeenCalledWith(
      undefined,
      "/tmp",
      "agent-conversation list",
    );
    expect(listConversationsSpy).toHaveBeenCalledWith(
      "auto-org",
      expect.any(Object),
    );
  });

  test("resolves and passes explicit project scope", async () => {
    resolveTargetSpy.mockResolvedValue({ org: ORG, project: PROJECT.slug });
    getProjectSpy.mockResolvedValue(PROJECT);
    listConversationsSpy.mockResolvedValue({ data: [] });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, `${ORG}/${PROJECT.slug}`);

    expect(getProjectSpy).toHaveBeenCalledWith(ORG, PROJECT.slug);
    expect(listConversationsSpy).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ project: PROJECT.id }),
    );
  });

  test("uses project data returned by bare-project search", async () => {
    resolveTargetSpy.mockResolvedValue({
      org: ORG,
      project: PROJECT.slug,
      projectData: PROJECT,
    });
    listConversationsSpy.mockResolvedValue({ data: [] });

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, JSON_FLAGS, PROJECT.slug);

    expect(getProjectSpy).not.toHaveBeenCalled();
    expect(listConversationsSpy).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ project: PROJECT.id }),
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
      expect.objectContaining({ query: "has:errors" }),
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
      ORG,
    );

    expect(listConversationsSpy).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ statsPeriod: "24h" }),
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
      expect.objectContaining({ limit: 50 }),
    );
  });

  test("preserves project and query in pagination hints", async () => {
    resolveTargetSpy.mockResolvedValue({
      org: ORG,
      project: PROJECT.slug,
      projectData: PROJECT,
    });
    listConversationsSpy.mockResolvedValue({
      data: sampleConversations,
      nextCursor: "next-cursor-abc",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(
      context,
      { ...HUMAN_FLAGS, query: "conversation.errors:>0" },
      `${ORG}/${PROJECT.slug}`,
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain(`Agent conversations in ${ORG}/${PROJECT.slug}:`);
    expect(output).toContain(
      `agent-conversation list ${ORG}/${PROJECT.slug} -c next`,
    );
    expect(output).toContain('-q "conversation.errors:>0"');
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
      "next-cursor",
    );
  });
});
