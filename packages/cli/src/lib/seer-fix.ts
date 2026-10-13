/** Interactive Seer orchestration; JSON callers receive one resumable result. */
import { setTimeout as sleep } from "node:timers/promises";
import { safeParse } from "valibot";
import { isTerminalStatus } from "../types/seer.js";
import {
  type ExplorerBlock,
  type ExplorerSession,
  FileApprovalDataSchema,
  type FixResult,
  type PendingUserInput,
  QuestionDataSchema,
  type SeerResponseData,
  type UserInputResponse,
} from "../types/seer-fix.js";
import {
  getSeerExplorerState,
  respondToSeerUserInput,
  triggerIssueFix,
} from "./api-client.js";
import { redactCredentialText } from "./credential-redaction.js";
import { ValidationError } from "./errors.js";
import { buildIssueUrl } from "./sentry-urls.js";

export type FixOptions = {
  org: string;
  issueId: string;
  issueArg: string;
  runId?: string | number;
  instruction?: string;
  response?: UserInputResponse;
  interactive: boolean;
  prompt?: (input: PendingUserInput) => Promise<SeerResponseData | null>;
  onBlocks?: (blocks: ExplorerBlock[]) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

/** Match the UI: aggregate merged patches, with later blocks overriding each file. */
export function extractFixPatches(
  session: ExplorerSession,
): FixResult["patches"] {
  const blocks = session.blocks ?? [];
  const hasMerged = blocks.some(
    (block) =>
      block.merged_file_patches !== null &&
      block.merged_file_patches !== undefined,
  );
  const patches = new Map<string, FixResult["patches"][number]>();
  for (const block of blocks) {
    for (const patch of (hasMerged
      ? block.merged_file_patches
      : block.file_patches) ?? []) {
      patches.set(`${patch.repo_name}:${patch.patch.path}`, patch);
    }
  }
  return [...patches.values()];
}

/** Validate the answer against the current question, never just the file's shape. */
export function validateSeerResponse(
  input: PendingUserInput,
  response: UserInputResponse,
): void {
  if (response.input_id !== input.id) {
    throw new ValidationError(
      "Response does not match the current pending input ID.",
      "--response",
    );
  }
  const data = response.response_data;
  if (input.input_type === "ask_user_question") {
    const parsed = safeParse(QuestionDataSchema, input.data);
    if (
      parsed.success &&
      "answers" in data &&
      data.answers.length === parsed.output.questions.length &&
      data.answers.every((answer) => answer.trim().length > 0)
    ) {
      return;
    }
  } else if (input.input_type === "file_change_approval") {
    const parsed = safeParse(FileApprovalDataSchema, input.data);
    if (
      parsed.success &&
      "decisions" in data &&
      data.decisions.length === parsed.output.patches.length
    ) {
      return;
    }
  } else {
    throw new ValidationError(
      `Input type '${input.input_type}' requires the Sentry UI.`,
      "--response",
    );
  }
  throw new ValidationError(
    "Response data must include one answer or decision for each current question or patch.",
    "--response",
  );
}

function supportsPrompt(input: PendingUserInput): boolean {
  if (input.input_type === "ask_user_question") {
    const result = safeParse(QuestionDataSchema, input.data);
    return result.success && result.output.questions.length > 0;
  }
  if (input.input_type === "file_change_approval") {
    const result = safeParse(FileApprovalDataSchema, input.data);
    return result.success && result.output.patches.length > 0;
  }
  return false;
}

function resumeCommand(options: FixOptions, runId: string | number): string {
  return `sentry issue fix ${options.issueArg} --run-id ${runId}`;
}

/** Preserve the selected chat when browser authorization is required. */
function buildSeerRunUrl(options: FixOptions, runId: string | number): string {
  const url = new URL(buildIssueUrl(options.org, options.issueId));
  url.searchParams.set("explorerRunId", String(runId));
  return url.toString();
}

/** Shared result contract is also used by local patch and PR delivery. */
export function buildFixResult(
  runId: string | number,
  session: ExplorerSession,
  nextAction?: string,
): FixResult {
  return {
    run_id: runId,
    status:
      session.status === "COMPLETED" && session.pending_user_input
        ? "WAITING_FOR_USER_RESPONSE"
        : session.status,
    pending_user_input: session.pending_user_input ?? null,
    patches: extractFixPatches(session),
    pr_urls: [
      ...new Set(
        Object.values(session.repo_pr_states ?? {}).flatMap((state) =>
          state.pr_url ? [state.pr_url] : [],
        ),
      ),
    ],
    ...(nextAction ? { next_action: nextAction } : {}),
  };
}

async function selectRun(
  options: FixOptions,
  signal: AbortSignal,
): Promise<string | number> {
  if (options.runId !== undefined) {
    return options.runId;
  }
  const run = await triggerIssueFix(options.org, options.issueId, {
    instruction: options.instruction,
    signal,
  });
  const runId = run.sentry_run_id ?? run.run_id;
  if (runId === undefined) {
    throw new Error("Unexpected fix response: missing run ID.");
  }
  return runId;
}

/** Poll the pinned run, submitting each pending ID at most once. */
export async function runSeerFix(options: FixOptions): Promise<FixResult> {
  if (options.response && options.runId === undefined) {
    throw new ValidationError("--response requires --run-id.", "--response");
  }
  if (options.instruction !== undefined && options.runId !== undefined) {
    throw new ValidationError(
      "--instruction applies to a new fix; omit --run-id.",
      "--instruction",
    );
  }
  const timeoutMs = Math.max(1, Math.ceil(options.timeoutMs ?? 360_000));
  const deadline = Date.now() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const runId = await selectRun(options, signal);
  let session: ExplorerSession = { status: "PROCESSING" };
  let fileResponse = options.response;
  const submitted = new Set<string>();
  const rendered = new Set<string>();
  try {
    while (Date.now() < deadline && !signal.aborted) {
      let state: ExplorerSession | null;
      try {
        state = await getSeerExplorerState(options.org, runId, { signal });
      } catch (error) {
        if (signal.aborted || Date.now() >= deadline) {
          break;
        }
        throw error;
      }
      if (state) {
        session = state;
        const newBlocks = (session.blocks ?? []).filter(
          (block) =>
            !rendered.has(block.id) && block.message?.content && !block.loading,
        );
        for (const block of newBlocks) {
          rendered.add(block.id);
        }
        options.onBlocks?.(newBlocks);
        const input = session.pending_user_input;
        if (fileResponse) {
          if (!input) {
            throw new ValidationError(
              "The run has no current pending input.",
              "--response",
            );
          }
          validateSeerResponse(input, fileResponse);
          submitted.add(input.id);
          const response = fileResponse;
          fileResponse = undefined;
          signal.throwIfAborted();
          await respondToSeerUserInput(options.org, runId, response, {
            signal,
          });
        } else if (input && !submitted.has(input.id)) {
          if (
            !(options.interactive && options.prompt && supportsPrompt(input))
          ) {
            const action = supportsPrompt(input)
              ? `Resume with ${resumeCommand(options, runId)} --response <file.json> (containing input_id and response_data).`
              : `Open ${buildSeerRunUrl(options, runId)} to handle '${input.input_type}', then resume with ${resumeCommand(options, runId)}.`;
            return buildFixResult(runId, session, action);
          }
          const responseData = await options.prompt(input);
          if (responseData === null) {
            return {
              ...buildFixResult(
                runId,
                session,
                `Resume with ${resumeCommand(options, runId)}.`,
              ),
              status: "CANCELLED",
            };
          }
          const response = { input_id: input.id, response_data: responseData };
          validateSeerResponse(input, response);
          submitted.add(input.id);
          signal.throwIfAborted();
          await respondToSeerUserInput(options.org, runId, response, {
            signal,
          });
        } else if (!input && isTerminalStatus(session.status)) {
          const action =
            session.status === "COMPLETED" &&
            extractFixPatches(session).length === 0
              ? `Seer produced no code changes. Start a new fix with sentry issue fix ${options.issueArg}.`
              : undefined;
          return buildFixResult(runId, session, action);
        } else if (
          !input &&
          (session.status === "WAITING_FOR_USER_RESPONSE" ||
            session.status === "NEED_MORE_INFORMATION")
        ) {
          return buildFixResult(
            runId,
            session,
            `Open ${buildSeerRunUrl(options, runId)} to provide input, then resume with ${resumeCommand(options, runId)}.`,
          );
        }
      }
      try {
        await sleep(
          Math.min(
            options.pollIntervalMs ?? 1000,
            Math.max(0, deadline - Date.now()),
          ),
          undefined,
          { signal },
        );
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    if (!signal.aborted) {
      return {
        ...buildFixResult(
          runId,
          session,
          `The update may have been accepted. Refresh the run with ${resumeCommand(options, runId)} before deciding whether to respond again.`,
        ),
        status: "ERROR",
        error: redactCredentialText(
          error instanceof Error ? error.message : "Seer request failed.",
        ),
      };
    }
  }
  return {
    ...buildFixResult(
      runId,
      session,
      `The run may still be active. Resume with ${resumeCommand(options, runId)}.`,
    ),
    status: options.signal?.aborted ? "CANCELLED" : "TIMEOUT",
  };
}
