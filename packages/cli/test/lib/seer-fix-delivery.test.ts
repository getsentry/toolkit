/** Delivery orchestration coverage using mocked network requests and real Git. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExplorerSession, FixResult } from "../../src/types/seer-fix.js";
import {
  apiRequestToRegion,
  getSeerExplorerState,
} from "../../src/lib/api-client.js";
import { resolveOrgRegion } from "../../src/lib/region.js";
import { deliverSeerFix } from "../../src/lib/seer-fix-delivery.js";
import { useTestConfigDir } from "../helpers.js";

vi.mock("../../src/lib/api-client.js", () => ({
  apiRequestToRegion: vi.fn(),
  getSeerExplorerState: vi.fn(),
  getAutofixState: vi.fn(),
  respondToSeerUserInput: vi.fn(),
  triggerIssueFix: vi.fn(),
}));
vi.mock("../../src/lib/region.js", () => ({ resolveOrgRegion: vi.fn() }));

const getDir = useTestConfigDir("seer-fix-delivery-");
const patch: FixResult["patches"][number] = {
  repo_name: "example/project",
  diff: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n",
  patch: {
    added: 1,
    removed: 1,
    hunks: [],
    path: "file.txt",
    source_file: "a/file.txt",
    target_file: "b/file.txt",
    type: "M",
  },
};
const result: FixResult = {
  run_id: "run-uuid",
  status: "COMPLETED",
  pending_user_input: null,
  patches: [patch],
  pr_urls: [],
};
const options = {
  org: "example-org",
  cwd: "/unused",
  apply: false,
  pr: true,
  timeoutMs: 1000,
  pollIntervalMs: 1,
};

function ready(patches = result.patches): ExplorerSession {
  return {
    status: "COMPLETED",
    blocks: [{ id: "changes", merged_file_patches: patches }],
  };
}

function session(
  status: "creating" | "completed" | "error",
  repo = "example/project",
): ExplorerSession {
  return {
    ...ready(),
    repo_pr_states: {
      [repo]: {
        repo_name: repo,
        pr_creation_status: status,
        ...(status === "completed"
          ? { pr_url: "https://github.com/example/project/pull/1" }
          : {}),
      },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveOrgRegion).mockResolvedValue("https://de.sentry.io");
  vi.mocked(apiRequestToRegion).mockResolvedValue({ data: {} });
  vi.mocked(getSeerExplorerState).mockResolvedValue(ready());
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function checkout(): Promise<string> {
  const repo = join(getDir(), "repo");
  await mkdir(repo);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  git(["init"]);
  git(["config", "core.autocrlf", "false"]);
  git(["remote", "add", "origin", "https://github.com/example/project.git"]);
  await writeFile(join(repo, "file.txt"), "before\n");
  git(["add", "."]);
  git([
    "-c",
    "user.name=Audit",
    "-c",
    "user.email=audit@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "test baseline",
  ]);
  return repo;
}

test("creates one PR using the wrapped no-retry request and polls beyond run completion", async () => {
  vi.mocked(getSeerExplorerState)
    .mockResolvedValueOnce(ready())
    .mockResolvedValueOnce(session("creating"))
    .mockResolvedValue(session("completed"));
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered).toMatchObject({
    status: "COMPLETED",
    patches: result.patches,
    pr_urls: ["https://github.com/example/project/pull/1"],
  });
  expect(resolveOrgRegion).toHaveBeenCalledWith("example-org");
  expect(apiRequestToRegion).toHaveBeenCalledExactlyOnceWith(
    "https://de.sentry.io",
    "/organizations/example-org/seer/explorer-update/run-uuid/",
    expect.objectContaining({
      method: "POST",
      retry: false,
      signal: expect.any(AbortSignal),
      body: { payload: { type: "create_pr", repo_name: "example/project" } },
    }),
  );
  expect(getSeerExplorerState).toHaveBeenCalledTimes(3);
});

test("preserves the generated patch when a creation POST has an uncertain outcome", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue(ready());
  vi.mocked(apiRequestToRegion).mockRejectedValue(
    new Error("Service unavailable"),
  );
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered).toMatchObject({
    status: "ERROR",
    run_id: "run-uuid",
    patches: result.patches,
  });
  expect(delivered.delivery_errors?.[0]).toContain("Service unavailable");
  expect(delivered.next_action).toContain("--run-id run-uuid");
  expect(apiRequestToRegion).toHaveBeenCalledOnce();
});

test("applies a completed fix to a real checkout only when explicitly requested", async () => {
  const cwd = await checkout();
  const delivered = await deliverSeerFix({
    ...options,
    cwd,
    result,
    apply: true,
    pr: false,
    timeoutMs: 10_000,
  });
  expect(delivered).toMatchObject({
    status: "COMPLETED",
    applied_files: ["file.txt"],
    patches: result.patches,
    pr_urls: [],
  });
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("after\n");
  expect(apiRequestToRegion).not.toHaveBeenCalled();
  expect(getSeerExplorerState).toHaveBeenCalledExactlyOnceWith(
    "example-org",
    "run-uuid",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("preserves local work and generated diffs when local application fails", async () => {
  const cwd = await checkout();
  await writeFile(join(cwd, "file.txt"), "my work\n");
  const delivered = await deliverSeerFix({
    ...options,
    cwd,
    result,
    apply: true,
    timeoutMs: 10_000,
  });
  expect(delivered).toMatchObject({ status: "ERROR", patches: result.patches });
  expect(delivered.applied_files).toBeUndefined();
  expect(delivered.delivery_errors?.[0]).toContain("local changes");
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("my work\n");
  expect(apiRequestToRegion).not.toHaveBeenCalled();
});

test.each(["apply", "pr"])(
  "refuses %s of ambiguous raw incremental edits to one file",
  async (action) => {
    const cwd = await checkout();
    await writeFile(
      join(cwd, "file.txt"),
      "first\ncontext one\ncontext two\nlast\n",
    );
    execFileSync("git", ["add", "file.txt"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Audit",
        "-c",
        "user.email=audit@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=",
        "commit",
        "-m",
        "two distant edit baseline",
      ],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    const first = {
      ...patch,
      diff: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n-first\n+changed first\n context one\n context two\n",
    };
    const latest = {
      ...patch,
      diff: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -2,3 +2,3 @@\n context one\n context two\n-last\n+changed last\n",
    };
    vi.mocked(getSeerExplorerState)
      .mockResolvedValueOnce({
        status: "COMPLETED",
        blocks: [
          { id: "first", file_patches: [first] },
          { id: "last", file_patches: [latest] },
        ],
      })
      .mockResolvedValue(session("completed"));
    const delivered = await deliverSeerFix({
      ...options,
      cwd,
      result: { ...result, patches: [latest] },
      apply: action === "apply",
      pr: action === "pr",
      timeoutMs: 10_000,
    });
    expect(delivered.status).toBe("ERROR");
    expect(delivered.delivery_errors?.[0]).toContain("merged");
    expect(delivered.patches).toEqual([latest]);
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
      "first\ncontext one\ncontext two\nlast\n",
    );
    expect(apiRequestToRegion).not.toHaveBeenCalled();
  },
);

test.each(["pending", "processing", "changed diff", "changed metadata"])(
  "refuses stale local delivery when fresh state has %s",
  async (change) => {
    const cwd = await checkout();
    const fresh = ready();
    if (change === "pending") {
      fresh.pending_user_input = {
        id: "approval",
        input_type: "file_change_approval",
        data: {},
      };
    } else if (change === "processing") {
      fresh.status = "PROCESSING";
    } else {
      fresh.blocks = [
        {
          id: "changes",
          merged_file_patches: [
            {
              ...patch,
              ...(change === "changed diff"
                ? { diff: patch.diff.replace("+after", "+different") }
                : { patch: { ...patch.patch, added: 2 } }),
            },
          ],
        },
      ];
    }
    vi.mocked(getSeerExplorerState).mockResolvedValue(fresh);
    const delivered = await deliverSeerFix({
      ...options,
      cwd,
      result,
      apply: true,
      pr: false,
      timeoutMs: 10_000,
    });
    expect(delivered.status).toBe("ERROR");
    expect(delivered.patches).toEqual(result.patches);
    expect(delivered.applied_files).toBeUndefined();
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("before\n");
    expect(apiRequestToRegion).not.toHaveBeenCalled();
  },
);

test.each(["PROCESSING", "changed patches"])(
  "refuses stale PR delivery when fresh state has %s",
  async (change) => {
    vi.mocked(getSeerExplorerState).mockResolvedValue(
      change === "PROCESSING"
        ? { ...ready(), status: "PROCESSING" }
        : ready([{ ...patch, diff: "different" }]),
    );
    const delivered = await deliverSeerFix({ ...options, result });
    expect(delivered.status).toBe("ERROR");
    expect(delivered.patches).toEqual(result.patches);
    expect(apiRequestToRegion).not.toHaveBeenCalled();
  },
);

test("compares patch metadata structurally rather than relying on object key order", async () => {
  const reordered = {
    ...patch,
    patch: {
      type: patch.patch.type,
      target_file: patch.patch.target_file,
      source_file: patch.patch.source_file,
      path: patch.patch.path,
      hunks: patch.patch.hunks,
      removed: patch.patch.removed,
      added: patch.patch.added,
    },
  };
  vi.mocked(getSeerExplorerState)
    .mockResolvedValueOnce(ready([reordered]))
    .mockResolvedValue(session("completed"));
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered.status).toBe("COMPLETED");
  expect(apiRequestToRegion).toHaveBeenCalledOnce();
});

test("keeps successful local application when subsequent PR creation fails", async () => {
  const cwd = await checkout();
  vi.mocked(getSeerExplorerState).mockResolvedValue(ready());
  vi.mocked(apiRequestToRegion).mockRejectedValue(
    new Error("Service unavailable"),
  );
  const delivered = await deliverSeerFix({
    ...options,
    cwd,
    result,
    apply: true,
    timeoutMs: 10_000,
  });
  expect(delivered).toMatchObject({
    status: "ERROR",
    applied_files: ["file.txt"],
    patches: result.patches,
  });
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("after\n");
  expect(apiRequestToRegion).toHaveBeenCalledOnce();
});

test("preserves successful application when the deadline expires after the write", async () => {
  const cwd = await checkout();
  vi.spyOn(Date, "now").mockImplementation(() =>
    readFileSync(join(cwd, "file.txt"), "utf8") === "after\n" ? 20_000 : 0,
  );
  const delivered = await deliverSeerFix({
    ...options,
    cwd,
    result,
    apply: true,
    pr: false,
    timeoutMs: 10_000,
  });
  expect(delivered).toMatchObject({
    status: "ERROR",
    applied_files: ["file.txt"],
    patches: result.patches,
  });
  expect(delivered.delivery_errors?.[0]).toContain("timed out");
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("after\n");
});

test.each([
  { ...result, status: "PROCESSING" },
  {
    ...result,
    pending_user_input: {
      id: "pending",
      input_type: "file_change_approval",
      data: {},
    },
  },
  { ...result, patches: [] },
])(
  "refuses delivery of incomplete or unapproved code changes %#",
  async (ineligible) => {
    const delivered = await deliverSeerFix({
      ...options,
      result: ineligible,
      apply: true,
    });
    expect(delivered.status).toBe("ERROR");
    expect(delivered.delivery_errors?.[0]).toContain("completed Seer fix");
    expect(delivered.patches).toEqual(ineligible.patches);
    expect(apiRequestToRegion).not.toHaveBeenCalled();
    expect(getSeerExplorerState).not.toHaveBeenCalled();
  },
);

test("returns the existing fix unchanged when delivery is skipped", async () => {
  expect(await deliverSeerFix({ ...options, result, pr: false })).toEqual(
    result,
  );
  expect(apiRequestToRegion).not.toHaveBeenCalled();
  expect(getSeerExplorerState).not.toHaveBeenCalled();
});

test("reuses a completed PR without another creation request", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue(session("completed"));
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered.pr_urls).toEqual([
    "https://github.com/example/project/pull/1",
  ]);
  expect(delivered.status).toBe("COMPLETED");
  expect(getSeerExplorerState).toHaveBeenCalledOnce();
  expect(apiRequestToRegion).not.toHaveBeenCalled();
});

test("awaits an already creating PR without another creation request", async () => {
  vi.mocked(getSeerExplorerState)
    .mockResolvedValueOnce(session("creating"))
    .mockResolvedValue(session("completed"));
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered.status).toBe("COMPLETED");
  expect(delivered.pr_urls).toEqual([
    "https://github.com/example/project/pull/1",
  ]);
  expect(apiRequestToRegion).not.toHaveBeenCalled();
  expect(getSeerExplorerState).toHaveBeenCalledTimes(2);
});

test("requests unique affected repositories once and preserves all PR URLs", async () => {
  const multi: FixResult = {
    ...result,
    patches: [
      patch,
      { ...patch, patch: { ...patch.patch, path: "second.txt" } },
      { ...patch, repo_name: "example/second" },
    ],
  };
  vi.mocked(getSeerExplorerState)
    .mockResolvedValueOnce(ready(multi.patches))
    .mockResolvedValueOnce(ready(multi.patches))
    .mockResolvedValue({
      ...ready(multi.patches),
      repo_pr_states: {
        "example/project": {
          repo_name: "example/project",
          pr_creation_status: "completed",
          pr_url: "https://github.com/example/project/pull/1",
        },
        "example/second": {
          repo_name: "example/second",
          pr_creation_status: "completed",
          pr_url: "https://github.com/example/second/pull/2",
        },
      },
    });
  const delivered = await deliverSeerFix({ ...options, result: multi });
  expect(delivered.status).toBe("COMPLETED");
  expect(delivered.pr_urls).toEqual([
    "https://github.com/example/project/pull/1",
    "https://github.com/example/second/pull/2",
  ]);
  expect(
    vi.mocked(apiRequestToRegion).mock.calls.map((call) => call[2]?.body),
  ).toEqual([
    { payload: { type: "create_pr", repo_name: "example/project" } },
    { payload: { type: "create_pr", repo_name: "example/second" } },
  ]);
  expect(getSeerExplorerState).toHaveBeenCalledTimes(3);
});

test("reports repository PR failure even though the conversation is completed", async () => {
  const failed: ExplorerSession = {
    ...ready(),
    repo_pr_states: {
      "example/project": {
        repo_name: "example/project",
        pr_creation_status: "error",
        pr_creation_error: "permission denied",
      },
    },
  };
  vi.mocked(getSeerExplorerState)
    .mockResolvedValueOnce(ready())
    .mockResolvedValue(failed);
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered.status).toBe("ERROR");
  expect(delivered.delivery_errors?.[0]).toContain("permission denied");
  expect(delivered.patches).toEqual(result.patches);
  expect(apiRequestToRegion).toHaveBeenCalledOnce();
});

test("preserves a completed repository PR when another repository fails", async () => {
  const multi = {
    ...result,
    patches: [patch, { ...patch, repo_name: "example/second" }],
  };
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    ...ready(multi.patches),
    repo_pr_states: {
      "example/project": {
        repo_name: "example/project",
        pr_creation_status: "completed",
        pr_url: "https://github.com/example/project/pull/1",
      },
      "example/second": {
        repo_name: "example/second",
        pr_creation_status: "error",
        pr_creation_error: "Branch conflict",
      },
    },
  });
  const delivered = await deliverSeerFix({ ...options, result: multi });
  expect(delivered.status).toBe("ERROR");
  expect(delivered.pr_urls).toEqual([
    "https://github.com/example/project/pull/1",
  ]);
  expect(delivered.delivery_errors?.[0]).toContain("Branch conflict");
  expect(apiRequestToRegion).not.toHaveBeenCalled();
});

test("pauses delivery when fresh state introduces a pending user input", async () => {
  const pending = {
    id: "new-approval",
    input_type: "file_change_approval",
    data: {},
  };
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: pending,
  });
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered).toMatchObject({
    status: "ERROR",
    pending_user_input: pending,
    patches: result.patches,
  });
  expect(apiRequestToRegion).not.toHaveBeenCalled();
});

test("bounds polling without repeating an already creating PR request", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue(session("creating"));
  const delivered = await deliverSeerFix({ ...options, result, timeoutMs: 10 });
  expect(delivered.status).toBe("ERROR");
  expect(delivered.delivery_errors?.[0]).toContain("timed out");
  expect(delivered.patches).toEqual(result.patches);
  expect(apiRequestToRegion).not.toHaveBeenCalled();
});

test("bounds region resolution and prevents a POST after its timeout", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue(ready());
  vi.mocked(resolveOrgRegion).mockReturnValue(new Promise(() => {}));
  const delivered = await deliverSeerFix({ ...options, result, timeoutMs: 10 });
  expect(delivered.status).toBe("ERROR");
  expect(delivered.delivery_errors?.[0]).toContain("timed out");
  expect(apiRequestToRegion).not.toHaveBeenCalled();
});

test("does not submit a PR after the budget expires before its timeout callback runs", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  vi.mocked(getSeerExplorerState)
    .mockResolvedValueOnce(ready())
    .mockResolvedValue(session("completed"));
  vi.mocked(resolveOrgRegion).mockImplementation(async () => {
    now.mockReturnValue(100);
    return "https://de.sentry.io";
  });
  const delivered = await deliverSeerFix({ ...options, result, timeoutMs: 50 });
  expect(delivered.status).toBe("ERROR");
  expect(delivered.delivery_errors?.[0]).toContain("timed out");
  expect(apiRequestToRegion).not.toHaveBeenCalled();
});

test("honors caller cancellation before any delivery request", async () => {
  const controller = new AbortController();
  controller.abort();
  const delivered = await deliverSeerFix({
    ...options,
    result,
    signal: controller.signal,
  });
  expect(delivered.status).toBe("ERROR");
  expect(delivered.delivery_errors?.[0]).toContain("cancelled");
  expect(apiRequestToRegion).not.toHaveBeenCalled();
  expect(getSeerExplorerState).not.toHaveBeenCalled();
});

test("bounds an uncertain creation POST and never repeats it", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue(ready());
  vi.mocked(apiRequestToRegion).mockReturnValue(new Promise(() => {}));
  const delivered = await deliverSeerFix({ ...options, result, timeoutMs: 10 });
  expect(delivered.status).toBe("ERROR");
  expect(delivered.delivery_errors?.[0]).toContain("timed out");
  expect(delivered.next_action).toContain("--run-id run-uuid");
  expect(apiRequestToRegion).toHaveBeenCalledOnce();
});

test("redacts credentials in repository and network error diagnostics", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue(ready());
  vi.mocked(apiRequestToRegion).mockRejectedValue(
    new Error("Authorization: Bearer secret-token sntryu_secret"),
  );
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered.error).not.toContain("secret-token");
  expect(delivered.error).not.toContain("sntryu_secret");
  expect(delivered.delivery_errors?.[0]).toContain("[REDACTED]");
});

test("refuses missing conversation state without requesting creation", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue(null);
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered.status).toBe("ERROR");
  expect(delivered.delivery_errors?.[0]).toContain("Cannot find");
  expect(apiRequestToRegion).not.toHaveBeenCalled();
});

test("refuses completed PR state missing its URL without requesting creation again", async () => {
  vi.mocked(getSeerExplorerState).mockResolvedValue({
    ...ready(),
    repo_pr_states: {
      "example/project": {
        repo_name: "example/project",
        pr_creation_status: "completed",
      },
    },
  });
  const delivered = await deliverSeerFix({ ...options, result });
  expect(delivered.status).toBe("ERROR");
  expect(delivered.delivery_errors?.[0]).toContain("without a PR URL");
  expect(apiRequestToRegion).not.toHaveBeenCalled();
});
