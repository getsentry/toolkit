import { beforeEach, expect, test, vi } from "vitest";
import { runSeerFix } from "../../src/lib/seer-fix.js";
import {
  getAutofixState,
  getSeerExplorerState,
  respondToSeerUserInput,
  triggerIssueFix,
} from "../../src/lib/api-client.js";
vi.mock("../../src/lib/api-client.js", () => ({
  getAutofixState: vi.fn(),
  getSeerExplorerState: vi.fn(),
  respondToSeerUserInput: vi.fn(),
  triggerIssueFix: vi.fn(),
}));
const pending = {
  id: "q1",
  input_type: "ask_user_question",
  data: {
    questions: [
      {
        question: "Behavior?",
        options: [{ label: "Keep", description: "Keep behavior" }],
      },
    ],
  },
};
const base = {
  org: "test-org",
  issueId: "12345",
  issueArg: "test-org/12345",
  interactive: false,
  pollIntervalMs: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAutofixState).mockResolvedValue(null);
  vi.mocked(triggerIssueFix).mockResolvedValue({ sentry_run_id: "run-1" });
});
test("JSON pauses with the current input and a pinned resume command", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: pending,
  });
  const result = await runSeerFix(base);
  expect(result).toMatchObject({
    run_id: "run-1",
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: pending,
    patches: [],
    pr_urls: [],
  });
  expect(result.next_action).toContain("--run-id run-1");
  expect(respondToSeerUserInput).not.toHaveBeenCalled();
});
test("submits a matching response once while the same input remains visible", async () => {
  vi.mocked(getSeerExplorerState)
    .mockResolvedValueOnce({
      status: "WAITING_FOR_USER_RESPONSE",
      pending_user_input: pending,
    })
    .mockResolvedValueOnce({
      status: "WAITING_FOR_USER_RESPONSE",
      pending_user_input: pending,
    })
    .mockResolvedValue({ status: "COMPLETED" });
  const result = await runSeerFix({
    ...base,
    runId: "run-1",
    response: { input_id: "q1", response_data: { answers: ["Keep"] } },
  });
  expect(result.status).toBe("COMPLETED");
  expect(respondToSeerUserInput).toHaveBeenCalledTimes(1);
  expect(getAutofixState).not.toHaveBeenCalled();
  expect(triggerIssueFix).not.toHaveBeenCalled();
});
test("rejects a stale response before submission", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: pending,
  });
  await expect(
    runSeerFix({
      ...base,
      runId: "run-1",
      response: { input_id: "old", response_data: { answers: ["Keep"] } },
    }),
  ).rejects.toThrow("current pending input");
  expect(respondToSeerUserInput).not.toHaveBeenCalled();
});
test("preserves a run ID when polling times out", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({ status: "PROCESSING" });
  const result = await runSeerFix({ ...base, timeoutMs: 5 });
  expect(result.status).toBe("TIMEOUT");
  expect(result.run_id).toBe("run-1");
  expect(result.next_action).toContain("--run-id run-1");
});
test("does not autoanswer unsupported write approvals", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: {
      id: "w1",
      input_type: "agent_write_approval",
      data: {},
    },
  });
  const prompt = vi.fn();
  const result = await runSeerFix({ ...base, interactive: true, prompt });
  expect(result.pending_user_input?.id).toBe("w1");
  expect(prompt).not.toHaveBeenCalled();
});
test("keeps the latest merged patch per file across repositories", async () => {
  const patch = {
    repo_name: "example/a",
    diff: "old",
    patch: {
      added: 1,
      removed: 1,
      hunks: [],
      path: "index.ts",
      source_file: "index.ts",
      target_file: "index.ts",
      type: "M" as const,
    },
  };
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "COMPLETED",
    blocks: [
      { id: "one", merged_file_patches: [patch] },
      {
        id: "two",
        merged_file_patches: [
          { ...patch, repo_name: "example/b", diff: "other" },
        ],
      },
      { id: "three", merged_file_patches: [{ ...patch, diff: "new" }] },
    ],
  });
  const result = await runSeerFix({ ...base, runId: "run-1" });
  expect(result.patches.map((item) => [item.repo_name, item.diff])).toEqual([
    ["example/a", "new"],
    ["example/b", "other"],
  ]);
});
test("starts an interactive fix independently of prior analysis", async () => {
  vi.mocked(getAutofixState).mockResolvedValue({
    sentry_run_id: "old",
    status: "COMPLETED",
    blocks: [],
  });
  vi.mocked(getSeerExplorerState).mockResolvedValue({ status: "COMPLETED" });
  const result = await runSeerFix(base);
  expect(result.run_id).toBe("run-1");
  expect(triggerIssueFix).toHaveBeenCalledOnce();
});
test("file approval answers must match the number of proposed patches", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: {
      id: "f1",
      input_type: "file_change_approval",
      data: {
        patches: [
          {
            repo_name: "example/a",
            patch: {
              added: 1,
              removed: 1,
              hunks: [],
              path: "index.ts",
              source_file: "index.ts",
              target_file: "index.ts",
              type: "M",
            },
          },
        ],
      },
    },
  });
  await expect(
    runSeerFix({
      ...base,
      runId: "run-1",
      response: { input_id: "f1", response_data: { decisions: [] } },
    }),
  ).rejects.toThrow("each current");
  expect(respondToSeerUserInput).not.toHaveBeenCalled();
});
test("preserves a run after an uncertain answer submission fails", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: pending,
  });
  vi.mocked(respondToSeerUserInput).mockRejectedValue(
    new Error("Service unavailable"),
  );
  const result = await runSeerFix({
    ...base,
    runId: "run-1",
    response: { input_id: "q1", response_data: { answers: ["Keep"] } },
  });
  expect(result).toMatchObject({
    run_id: "run-1",
    status: "ERROR",
    error: "Service unavailable",
  });
  expect(result.next_action).toContain("--run-id run-1");
  expect(respondToSeerUserInput).toHaveBeenCalledOnce();
});
test("honors a new instruction instead of returning an old completed fix", async () => {
  vi.mocked(getAutofixState).mockResolvedValue({
    sentry_run_id: "old",
    status: "COMPLETED",
    blocks: [
      {
        id: "old",
        file_patches: [
          {
            repo_name: "example/a",
            diff: "old",
            patch: {
              added: 1,
              removed: 1,
              hunks: [],
              path: "index.ts",
              source_file: "index.ts",
              target_file: "index.ts",
              type: "M",
            },
          },
        ],
      },
    ],
  });
  vi.mocked(getSeerExplorerState).mockResolvedValue({ status: "COMPLETED" });
  const result = await runSeerFix({ ...base, instruction: "New constraint" });
  expect(result.run_id).toBe("run-1");
});
test("does not submit a human answer after the operation deadline", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: pending,
  });
  const prompt = () =>
    new Promise<{ answers: string[] }>((resolve) => {
      setTimeout(() => resolve({ answers: ["Keep"] }), 10);
    });
  const result = await runSeerFix({
    ...base,
    runId: "run-1",
    timeoutMs: 5,
    interactive: true,
    prompt,
  });
  expect(result.status).toBe("TIMEOUT");
  expect(respondToSeerUserInput).not.toHaveBeenCalled();
});
test("returns a cancelled resumable result when a human cancels a prompt", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: pending,
  });
  const result = await runSeerFix({
    ...base,
    runId: "run-1",
    interactive: true,
    prompt: async () => null,
  });
  expect(result).toMatchObject({
    run_id: "run-1",
    status: "CANCELLED",
    pending_user_input: pending,
  });
  expect(result.next_action).toContain("--run-id run-1");
  expect(respondToSeerUserInput).not.toHaveBeenCalled();
});
test("pauses completed sessions that still contain unsupported pending input", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "COMPLETED",
    pending_user_input: {
      id: "w1",
      input_type: "agent_write_approval",
      data: { requiredScopes: ["event:write"], sessionId: "session-1" },
    },
  });
  const result = await runSeerFix({ ...base, runId: "run-1" });
  expect(result.status).toBe("WAITING_FOR_USER_RESPONSE");
  expect(result.pending_user_input?.id).toBe("w1");
  expect(respondToSeerUserInput).not.toHaveBeenCalled();
});
test.each([
  {
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: {
      id: "browser",
      input_type: "reauth_monitoring_provider",
      data: {},
    },
  },
  { status: "WAITING_FOR_USER_RESPONSE" },
])("links the pinned chat for browser recovery: %j", async (session) => {
  vi.mocked(getSeerExplorerState).mockResolvedValue(session);
  const result = await runSeerFix({ ...base, runId: "run-1" });
  const runUrl = result.next_action?.match(/https?:\/\/\S+/)?.[0];
  expect(runUrl).toBeDefined();
  const url = new URL(runUrl ?? "https://invalid.example");
  expect(url.pathname).toContain("/issues/12345/");
  expect(url.searchParams.get("explorerRunId")).toBe("run-1");
});
