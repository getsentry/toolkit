/** Human output and interactive review for Seer fixes. */
import { safeParse } from "valibot";
import {
  FileApprovalDataSchema,
  type FixResult,
  type PendingUserInput,
  QuestionDataSchema,
  type SeerResponseData,
} from "../../types/seer-fix.js";
import type { Writer } from "../../types/index.js";
import type { ExplorerBlock } from "../../types/seer-fix.js";
import type { FixDeliveryResult } from "../seer-fix-delivery.js";
import type { HumanRenderer } from "./output.js";
import { logger } from "../logger.js";
import { escapeMarkdownInline, renderMarkdown } from "./markdown.js";

export function formatSeerFix(result: FixResult): string {
  const lines = [
    `# Seer fix`,
    `Run: ${escapeMarkdownInline(String(result.run_id))}`,
    `Status: ${escapeMarkdownInline(result.status)}`,
  ];
  if (result.pending_user_input) {
    lines.push(
      `Waiting for input: ${escapeMarkdownInline(result.pending_user_input.input_type)} (${escapeMarkdownInline(result.pending_user_input.id)})`,
    );
  }
  for (const patch of result.patches) {
    lines.push(
      `## ${escapeMarkdownInline(patch.repo_name)}: ${escapeMarkdownInline(patch.patch.path)}`,
      "```diff",
      patch.diff,
      "```",
    );
  }
  if (result.status === "COMPLETED" && result.patches.length === 0) {
    lines.push("Seer completed without code changes.");
  }
  for (const url of result.pr_urls) {
    lines.push(url);
  }
  if (result.error) {
    lines.push(escapeMarkdownInline(result.error));
  }
  if (result.next_action) {
    lines.push("", result.next_action);
  }
  return renderMarkdown(lines.join("\n\n"));
}

/** Prompt only for the exact input contracts the backend has verified. */
export async function promptSeerInput(
  input: PendingUserInput,
  writer: Writer,
): Promise<SeerResponseData | null> {
  const log = logger.withTag("issue.fix");
  if (input.input_type === "ask_user_question") {
    const parsed = safeParse(QuestionDataSchema, input.data);
    if (!parsed.success) {
      return null;
    }
    const answers: string[] = [];
    for (const question of parsed.output.questions) {
      for (const option of question.options) {
        writer.write(`${option.label}: ${option.description}\n`);
      }
      const selection =
        question.options.length > 0
          ? await log.prompt(question.question, {
              type: "select",
              cancel: "symbol",
              options: [
                ...question.options.map((option) => option.label),
                "Other (enter an answer)",
              ],
            })
          : "Other (enter an answer)";
      const answer =
        selection === "Other (enter an answer)"
          ? await log.prompt(question.question, {
              type: "text",
              cancel: "symbol",
            })
          : selection;
      if (typeof answer !== "string" || !answer.trim()) {
        return null;
      }
      answers.push(answer);
    }
    return { answers };
  }
  if (input.input_type === "file_change_approval") {
    const parsed = safeParse(FileApprovalDataSchema, input.data);
    if (!parsed.success) {
      return null;
    }
    const decisions: boolean[] = [];
    for (const entry of parsed.output.patches) {
      writer.write(`${entry.repo_name}: ${entry.patch.path}\n`);
      for (const hunk of entry.patch.hunks) {
        writer.write(
          `@@ -${hunk.source_start},${hunk.source_length} +${hunk.target_start},${hunk.target_length} @@ ${hunk.section_header}\n`,
        );
        for (const line of hunk.lines) {
          writer.write(`${line.line_type}${line.value}\n`);
        }
      }
      const decision = await log.prompt("Approve this proposed file change?", {
        type: "confirm",
        initial: false,
        cancel: "symbol",
      });
      if (typeof decision !== "boolean") {
        return null;
      }
      decisions.push(decision);
    }
    return { decisions };
  }
  return null;
}

/** Render private transcript directly to the terminal, avoiding telemetry reporters. */
export function createSeerBlockRenderer(
  writer: Writer,
): (blocks: ExplorerBlock[]) => void {
  return (blocks) => {
    for (const block of blocks) {
      if (block.message?.content) {
        writer.write(`${renderMarkdown(block.message.content)}\n`);
      }
    }
  };
}

export type SeerDeliveryChoice = { apply: boolean; pr: boolean };

/** Delivery is optional; selecting or cancelling the default keeps the fix read-only. */
export async function promptSeerDelivery(): Promise<SeerDeliveryChoice> {
  const selection = await logger
    .withTag("issue.fix")
    .prompt("What would you like to do with this fix?", {
      type: "select",
      initial: "Skip",
      cancel: "symbol",
      options: ["Apply locally", "Create PR", "Both", "Skip"],
    });
  return {
    apply: selection === "Apply locally" || selection === "Both",
    pr: selection === "Create PR" || selection === "Both",
  };
}

function formatDeliverySummary(
  result: FixDeliveryResult,
  includeContext: boolean,
): string {
  const lines: string[] = [];
  if (includeContext) {
    lines.push(`# Delivery`, `Status: ${escapeMarkdownInline(result.status)}`);
  }
  if (result.applied_files && result.applied_files.length > 0) {
    lines.push(
      "Applied locally:",
      ...result.applied_files.map((path) => `- ${escapeMarkdownInline(path)}`),
    );
  }
  if (includeContext) {
    for (const url of result.pr_urls) {
      lines.push(url);
    }
  }
  const errors = result.delivery_errors ?? [];
  for (const error of errors) {
    if (includeContext || error !== result.error) {
      lines.push(`Delivery failed: ${escapeMarkdownInline(error)}`);
    }
  }
  if (includeContext && result.error && !errors.includes(result.error)) {
    lines.push(escapeMarkdownInline(result.error));
  }
  if (includeContext && result.next_action) {
    lines.push("", result.next_action);
  }
  return lines.length > 0 ? renderMarkdown(lines.join("\n\n")) : "";
}

/** Each invocation previews its diffs once, followed only by delivery summaries. */
export function createSeerFixRenderer(): HumanRenderer<FixDeliveryResult> {
  let previewed = false;
  return {
    render(result) {
      if (previewed) {
        return formatDeliverySummary(result, true);
      }
      previewed = true;
      return [formatSeerFix(result), formatDeliverySummary(result, false)]
        .filter(Boolean)
        .join("\n\n");
    },
  };
}
