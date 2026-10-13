/** Explicit and interactive Seer fix delivery through the real command wrapper. */
import { isatty } from "node:tty";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixCommand } from "../../../src/commands/issue/fix.js";
import { resolveOrgAndIssueId } from "../../../src/commands/issue/utils.js";
import { OutputError } from "../../../src/lib/errors.js";
import { runSeerFix } from "../../../src/lib/seer-fix.js";
import { deliverSeerFix } from "../../../src/lib/seer-fix-delivery.js";
import type { FixResult } from "../../../src/types/seer-fix.js";
import { useTestConfigDir } from "../../helpers.js";
const log = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock("node:tty", () => ({ isatty: vi.fn() }));
vi.mock("../../../src/lib/logger.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/logger.js")>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      withTag: (tag: string) => {
        const scoped = actual.logger.withTag(tag);
        scoped.prompt = log.prompt;
        return scoped;
      },
    },
  };
});
vi.mock("../../../src/lib/seer-fix.js", () => ({ runSeerFix: vi.fn() }));
vi.mock("../../../src/lib/seer-fix-delivery.js", () => ({
  deliverSeerFix: vi.fn(),
}));
vi.mock("../../../src/commands/issue/utils.js", () => ({
  resolveOrgAndIssueId: vi.fn(),
  issueIdPositional: {
    kind: "tuple",
    parameters: [{ placeholder: "issue", parse: String }],
  },
}));
useTestConfigDir("test-issue-fix-delivery-");
const ready: FixResult = {
  run_id: "run-1",
  status: "COMPLETED",
  pending_user_input: null,
  patches: [
    {
      repo_name: "example/app",
      diff: "--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
      patch: {
        added: 1,
        removed: 1,
        path: "index.ts",
        source_file: "index.ts",
        target_file: "index.ts",
        type: "M",
        hunks: [],
      },
    },
  ],
  pr_urls: [],
};
const flags = {
  json: false,
  fresh: false,
  timeout: 360,
  apply: false,
  pr: false,
};
function context() {
  return {
    cwd: "/tmp",
    stdout: { write: vi.fn((_value: string) => true) },
    stderr: { write: vi.fn((_value: string) => true) },
  };
}
function output(ctx: ReturnType<typeof context>): string {
  return ctx.stdout.write.mock.calls.map(([value]) => value).join("");
}
async function run(
  ctx: ReturnType<typeof context>,
  overrides: Partial<typeof flags> = {},
) {
  const func = await fixCommand.loader();
  return func.call(ctx, { ...flags, ...overrides }, "test-org/12345");
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isatty).mockReturnValue(false);
  vi.mocked(resolveOrgAndIssueId).mockResolvedValue({
    org: "test-org",
    issueId: "12345",
  });
  vi.mocked(runSeerFix).mockResolvedValue(ready);
  vi.mocked(deliverSeerFix).mockResolvedValue({
    ...ready,
    applied_files: ["index.ts"],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
test("JSON defaults to preview without prompting or delivering", async () => {
  const ctx = context();
  vi.mocked(isatty).mockReturnValue(true);
  await run(ctx, { json: true });
  expect(JSON.parse(output(ctx))).toEqual(ready);
  expect(deliverSeerFix).not.toHaveBeenCalled();
  expect(log.prompt).not.toHaveBeenCalled();
});
test("explicit apply delivers and yields one aggregate JSON document", async () => {
  const ctx = context();
  await run(ctx, { json: true, apply: true });
  expect(deliverSeerFix).toHaveBeenCalledWith(
    expect.objectContaining({
      org: "test-org",
      cwd: "/tmp",
      result: ready,
      apply: true,
      pr: false,
    }),
  );
  expect(JSON.parse(output(ctx))).toMatchObject({
    patches: ready.patches,
    applied_files: ["index.ts"],
  });
  expect(log.prompt).not.toHaveBeenCalled();
});
test("previews diffs before an interactive delivery choice", async () => {
  const ctx = context();
  vi.mocked(isatty).mockReturnValue(true);
  let previewVisible = false;
  log.prompt.mockImplementation(async () => {
    previewVisible = output(ctx).includes("index.ts");
    return "Both";
  });
  await run(ctx);
  expect(previewVisible).toBe(true);
  expect(deliverSeerFix).toHaveBeenCalledWith(
    expect.objectContaining({ apply: true, pr: true }),
  );
  expect(output(ctx).match(/\+new/g)).toHaveLength(1);
});
test.each(["Skip", Symbol("cancel")])(
  "skips delivery when the interactive selection is %s",
  async (selection) => {
    const ctx = context();
    vi.mocked(isatty).mockReturnValue(true);
    log.prompt.mockResolvedValue(selection);
    await run(ctx);
    expect(deliverSeerFix).not.toHaveBeenCalled();
    expect(log.prompt).toHaveBeenCalledWith(
      "What would you like to do with this fix?",
      expect.objectContaining({ initial: "Skip", cancel: "symbol" }),
    );
  },
);
test("a non-TTY preview never prompts or delivers by default", async () => {
  const ctx = context();
  await run(ctx);
  expect(output(ctx)).toContain("index.ts");
  expect(log.prompt).not.toHaveBeenCalled();
  expect(deliverSeerFix).not.toHaveBeenCalled();
});
test("pending input blocks explicit delivery", async () => {
  const paused = {
    ...ready,
    status: "WAITING_FOR_USER_RESPONSE",
    pending_user_input: { id: "q1", input_type: "ask_user_question", data: {} },
  };
  vi.mocked(runSeerFix).mockResolvedValue(paused);
  const ctx = context();
  await run(ctx, { json: true, apply: true, pr: true });
  expect(JSON.parse(output(ctx))).toEqual(paused);
  expect(deliverSeerFix).not.toHaveBeenCalled();
});
test("delivery failures retain diffs in JSON and exit nonzero", async () => {
  vi.mocked(deliverSeerFix).mockResolvedValue({
    ...ready,
    status: "ERROR",
    delivery_errors: ["Dirty target file"],
  });
  const ctx = context();
  await expect(run(ctx, { json: true, apply: true })).rejects.toBeInstanceOf(
    OutputError,
  );
  expect(JSON.parse(output(ctx))).toMatchObject({
    patches: ready.patches,
    delivery_errors: ["Dirty target file"],
  });
});
test("an expired interactive delivery budget prevents every mutation", async () => {
  const ctx = context();
  vi.mocked(isatty).mockReturnValue(true);
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  log.prompt.mockImplementation(async () => {
    now = 3000;
    return "Apply locally";
  });
  await expect(run(ctx, { timeout: 1 })).rejects.toBeInstanceOf(OutputError);
  expect(deliverSeerFix).not.toHaveBeenCalled();
  expect(output(ctx)).toContain("TIMEOUT");
});
