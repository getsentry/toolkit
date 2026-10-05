/**
 * Conversation View Command Tests
 *
 * Tests for the `sentry agent-conversation view` command func() body, covering:
 * - Resolving org + conversationId from a single `<org>/<conversation-id>` arg
 * - Resolving org via resolveOrg when only the conversation-id is given
 * - Throwing error when no args provided
 * - Throwing ContextError when org cannot be resolved
 * - Yielding CommandOutput with transcript result
 * - Setting truncated flag from API response
 *
 * Uses spyOn mocking to avoid real HTTP calls or database access.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { viewCommand } from "../../../src/commands/agent-conversation/view.js";

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

import { ContextError } from "../../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import type { AgentConversationSpan } from "../../../src/types/conversation.js";

// ============================================================================
// Helpers
// ============================================================================

const ORG = "test-org";
const CONVERSATION_ID = "conv-abc-123";

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

function makeSpan(
  overrides: Partial<AgentConversationSpan> = {}
): AgentConversationSpan {
  return {
    "gen_ai.conversation.id": CONVERSATION_ID,
    span_id: "aabb112233445566",
    trace: "00112233445566778899aabbccddeeff",
    project: "my-project",
    "project.id": 42,
    "span.name": "gen_ai.invoke_agent",
    "span.status": "ok",
    "precise.start_ts": 1_716_500_000,
    "precise.finish_ts": 1_716_500_010,
    "gen_ai.operation.type": "ai_client",
    "gen_ai.input.messages": '{"messages":[{"role":"user","content":"hi"}]}',
    "gen_ai.output.messages":
      '{"messages":[{"role":"assistant","content":"hello"}]}',
    "gen_ai.usage.total_tokens": "100",
    "gen_ai.request.model": "gpt-4",
    "gen_ai.response.model": "gpt-4",
    ...overrides,
  };
}

const sampleSpans: AgentConversationSpan[] = [
  makeSpan(),
  makeSpan({
    span_id: "ccdd112233445566",
    "precise.start_ts": 1_716_500_020,
    "precise.finish_ts": 1_716_500_030,
    "gen_ai.input.messages":
      '{"messages":[{"role":"user","content":"what is 2+2?"}]}',
    "gen_ai.output.messages":
      '{"messages":[{"role":"assistant","content":"4"}]}',
  }),
];

const JSON_FLAGS = { json: true, fresh: false } as const;
const HUMAN_FLAGS = { json: false, fresh: false } as const;

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

describe("viewCommand.func", () => {
  let getConversationSpansSpy: ReturnType<typeof vi.spyOn>;
  let resolveOrgSpy: ReturnType<typeof vi.spyOn>;
  let withProgressSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getConversationSpansSpy = vi.spyOn(apiClient, "getConversationSpans");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    // Default: org resolves to ORG. Individual tests override for auto-detect
    // or resolution-failure scenarios.
    resolveOrgSpy.mockResolvedValue({ org: ORG });
    withProgressSpy = vi
      .spyOn(polling, "withProgress")
      .mockImplementation(mockWithProgress);
  });

  afterEach(() => {
    getConversationSpansSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    withProgressSpy.mockRestore();
  });

  test("resolves org + conversationId from a slash-separated arg", async () => {
    resolveOrgSpy.mockResolvedValue({ org: ORG });
    getConversationSpansSpy.mockResolvedValue({
      spans: sampleSpans,
      truncated: false,
      title: null,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, JSON_FLAGS, `${ORG}/${CONVERSATION_ID}`);

    // resolveOrg is called with the explicit org from the arg
    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: ORG })
    );
    // Should call getConversationSpans with the resolved org and conversation ID
    expect(getConversationSpansSpy).toHaveBeenCalledWith(ORG, CONVERSATION_ID);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.conversationId).toBe(CONVERSATION_ID);
  });

  test("resolves org via resolveOrg when only conversation-id is given", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "auto-org" });
    getConversationSpansSpy.mockResolvedValue({
      spans: sampleSpans,
      truncated: false,
      title: null,
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    // Only conversation ID provided — org should be auto-resolved
    await func.call(context, JSON_FLAGS, CONVERSATION_ID);

    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: undefined })
    );
    expect(getConversationSpansSpy).toHaveBeenCalledWith(
      "auto-org",
      CONVERSATION_ID
    );
  });

  test("throws error when no args provided", async () => {
    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, HUMAN_FLAGS, undefined as unknown as string)
    ).rejects.toThrow(ContextError);
  });

  test("no-args error mentions Conversation ID", async () => {
    const { context } = createMockContext();
    const func = await viewCommand.loader();

    try {
      await func.call(context, HUMAN_FLAGS, undefined as unknown as string);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      expect((error as ContextError).message).toContain("Conversation ID");
    }
  });

  test("throws ContextError when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, HUMAN_FLAGS, CONVERSATION_ID)
    ).rejects.toThrow(ContextError);
  });

  test("ContextError mentions Organization", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    try {
      await func.call(context, HUMAN_FLAGS, CONVERSATION_ID);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      expect((error as ContextError).message).toContain("organization");
    }
  });

  test("yields CommandOutput with transcript result (JSON)", async () => {
    getConversationSpansSpy.mockResolvedValue({
      spans: sampleSpans,
      truncated: false,
      title: null,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, JSON_FLAGS, `${ORG}/${CONVERSATION_ID}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.conversationId).toBe(CONVERSATION_ID);
    expect(parsed.org).toBe(ORG);
    expect(parsed.spanCount).toBe(2);
    expect(parsed.turns).toBeDefined();
    expect(Array.isArray(parsed.turns)).toBe(true);
  });

  test("yields human output with transcript", async () => {
    getConversationSpansSpy.mockResolvedValue({
      spans: sampleSpans,
      truncated: false,
      title: null,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, HUMAN_FLAGS, `${ORG}/${CONVERSATION_ID}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain(CONVERSATION_ID);
    expect(output).toContain(ORG);
  });

  test("sets truncated flag from API response (true)", async () => {
    getConversationSpansSpy.mockResolvedValue({
      spans: sampleSpans,
      truncated: true,
      title: null,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, JSON_FLAGS, `${ORG}/${CONVERSATION_ID}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.truncated).toBe(true);
  });

  test("sets truncated flag from API response (false)", async () => {
    getConversationSpansSpy.mockResolvedValue({
      spans: sampleSpans,
      truncated: false,
      title: null,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, JSON_FLAGS, `${ORG}/${CONVERSATION_ID}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    // When truncated is false, buildTranscriptResult does not set it,
    // and the command sets result.truncated = false
    expect(parsed.truncated).toBeFalsy();
  });

  test("shows truncation warning in human output", async () => {
    getConversationSpansSpy.mockResolvedValue({
      spans: sampleSpans,
      truncated: true,
      title: null,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, HUMAN_FLAGS, `${ORG}/${CONVERSATION_ID}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("truncated");
  });

  test("handles empty spans", async () => {
    getConversationSpansSpy.mockResolvedValue({
      spans: [],
      truncated: false,
      title: null,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, HUMAN_FLAGS, `${ORG}/${CONVERSATION_ID}`);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No spans found");
  });
});
