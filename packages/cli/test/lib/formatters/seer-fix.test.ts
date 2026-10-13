import { beforeEach, expect, test, vi } from "vitest";
import {
  createSeerBlockRenderer,
  createSeerFixRenderer,
  promptSeerDelivery,
  promptSeerInput,
} from "../../../src/lib/formatters/seer-fix.js";
const log = vi.hoisted(() => ({ prompt: vi.fn(), info: vi.fn() }));
vi.mock("../../../src/lib/logger.js", () => ({
  logger: { withTag: () => log },
}));
beforeEach(() => {
  vi.resetAllMocks();
});
test("renders private transcript directly to the writer", () => {
  let output = "";
  createSeerBlockRenderer({
    write: (chunk) => {
      output += chunk;
    },
  })([
    {
      id: "b1",
      message: { role: "assistant", content: "Repository private context" },
    },
  ]);
  expect(output).toContain("Repository private context");
  expect(log.info).not.toHaveBeenCalled();
});
test("previews file changes without forwarding their content to telemetry", async () => {
  let output = "";
  log.prompt.mockResolvedValue(false);
  const result = await promptSeerInput(
    {
      id: "f1",
      input_type: "file_change_approval",
      data: {
        patches: [
          {
            repo_name: "private/repo",
            patch: {
              added: 1,
              removed: 0,
              path: "index.ts",
              source_file: "index.ts",
              target_file: "index.ts",
              type: "M",
              hunks: [
                {
                  section_header: "",
                  source_length: 0,
                  source_start: 1,
                  target_length: 1,
                  target_start: 1,
                  lines: [
                    {
                      diff_line_no: 1,
                      line_type: "+",
                      source_line_no: null,
                      target_line_no: 1,
                      value: "private repository code",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    {
      write: (chunk) => {
        output += chunk;
      },
    },
  );
  expect(result).toEqual({ decisions: [false] });
  expect(output).toContain("+private repository code");
  expect(log.info).not.toHaveBeenCalled();
  expect(log.prompt).toHaveBeenCalledWith(
    "Approve this proposed file change?",
    { type: "confirm", initial: false, cancel: "symbol" },
  );
});
test("allows a custom answer for a question and stops on cancellation", async () => {
  log.prompt
    .mockResolvedValueOnce("Other (enter an answer)")
    .mockResolvedValueOnce("Custom answer");
  const input = {
    id: "q1",
    input_type: "ask_user_question",
    data: {
      questions: [
        {
          question: "Behavior?",
          options: [{ label: "Keep", description: "Preserve behavior" }],
        },
      ],
    },
  };
  expect(await promptSeerInput(input, { write: () => {} })).toEqual({
    answers: ["Custom answer"],
  });
  log.prompt.mockResolvedValueOnce(Symbol("cancel"));
  expect(await promptSeerInput(input, { write: () => {} })).toBeNull();
});

test("renders preview diffs once and then shows only delivery results", () => {
  const renderer = createSeerFixRenderer();
  const result = {
    run_id: "run-1",
    status: "COMPLETED",
    pending_user_input: null,
    patches: [
      {
        repo_name: "private/repo",
        diff: "--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-old\n+private-code\n",
        patch: {
          added: 1,
          removed: 1,
          path: "index.ts",
          source_file: "index.ts",
          target_file: "index.ts",
          type: "M" as const,
          hunks: [],
        },
      },
    ],
    pr_urls: [],
  };
  const preview = renderer.render(result);
  const delivered = renderer.render({
    ...result,
    applied_files: ["index.ts"],
    pr_urls: ["https://github.com/private/repo/pull/1"],
  });
  expect(preview).toContain("+private-code");
  expect(delivered).not.toContain("+private-code");
  expect(delivered).toContain("index.ts");
  expect(delivered).toContain("https://github.com/private/repo/pull/1");
  expect(log.info).not.toHaveBeenCalled();
});
test("preserves partial delivery evidence alongside failures", () => {
  const renderer = createSeerFixRenderer();
  const output = renderer.render({
    run_id: "run-1",
    status: "ERROR",
    pending_user_input: null,
    patches: [],
    pr_urls: ["https://github.com/private/repo/pull/1"],
    applied_files: ["index.ts"],
    delivery_errors: ["Second repository failed"],
  });
  expect(output).toContain("index.ts");
  expect(output).toContain("Second repository failed");
  expect(output).toContain("https://github.com/private/repo/pull/1");
});
test("delivery prompt defaults to skip and treats cancellation as skip", async () => {
  log.prompt.mockResolvedValue(Symbol("cancel"));
  expect(await promptSeerDelivery()).toEqual({ apply: false, pr: false });
  expect(log.prompt).toHaveBeenCalledWith(
    "What would you like to do with this fix?",
    {
      type: "select",
      initial: "Skip",
      cancel: "symbol",
      options: ["Apply locally", "Create PR", "Both", "Skip"],
    },
  );
});
