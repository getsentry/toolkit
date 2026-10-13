/** Generate and review code changes with Seer; resume structured input safely. */
import { readFile } from "node:fs/promises";
import { isatty } from "node:tty";
import { safeParse } from "valibot";
import type { SentryContext } from "../../context.js";
import {
  UserInputResponseSchema,
  type UserInputResponse,
} from "../../types/seer-fix.js";
import { buildCommand } from "../../lib/command.js";
import { ApiError, OutputError, ValidationError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { handleSeerApiError } from "../../lib/formatters/seer.js";
import {
  createSeerBlockRenderer,
  createSeerFixRenderer,
  promptSeerDelivery,
  promptSeerInput,
} from "../../lib/formatters/seer-fix.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import {
  deliverSeerFix,
  type FixDeliveryResult,
} from "../../lib/seer-fix-delivery.js";
import { runSeerFix } from "../../lib/seer-fix.js";
import { issueIdPositional, resolveOrgAndIssueId } from "./utils.js";

type FixFlags = {
  readonly json: boolean;
  readonly fresh: boolean;
  readonly apply: boolean;
  readonly pr: boolean;
  readonly instruction?: string;
  readonly "run-id"?: string;
  readonly response?: string;
  readonly timeout: number;
  readonly fields?: string[];
};

async function readResponse(
  path: string | undefined,
): Promise<UserInputResponse | undefined> {
  if (path === undefined) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ValidationError(
      "Unable to read --response as a JSON file.",
      "--response",
    );
  }
  const parsed = safeParse(UserInputResponseSchema, value);
  if (!parsed.success) {
    throw new ValidationError(
      "--response must contain input_id and response_data with answers or decisions.",
      "--response",
    );
  }
  return parsed.output;
}

function parseTimeout(value: string): number {
  const seconds = Number(value);
  if (!(Number.isFinite(seconds) && seconds > 0 && seconds <= 86_400)) {
    throw new ValidationError(
      "--timeout must be a positive number of seconds, up to 86400.",
      "--timeout",
    );
  }
  return seconds;
}

export const fixCommand = buildCommand({
  docs: {
    brief: "Generate and review code changes using Seer AI",
    fullDescription:
      "Generate code changes for an issue using Seer AI. Review questions and proposed file changes in an interactive terminal.\n\nJSON and non-interactive sessions pause with a run ID and pending input. Resume using --run-id and --response with a JSON file containing input_id and response_data.\n\nCompleted fixes preview diffs. Use --apply to apply the validated patch batch locally or --pr to create pull requests. In an interactive terminal, choose apply, PR, both, or the default Skip after reviewing the preview. JSON and non-interactive sessions deliver only with explicit flags. Requires Seer coding access, linked repositories, and a signed-in Sentry user.\n\nEach invocation starts a new interactive chat. Use --run-id to resume a specific chat; the issue argument resolves its organization. --instruction supplies context for a new fix.\n\nExamples:\n  sentry issue fix @latest\n  sentry issue fix my-org/CLI-G --instruction 'Preserve compatibility'\n  sentry issue fix my-org/CLI-G --json\n  sentry issue fix my-org/CLI-G --run-id <run> --response answer.json --json",
  },
  output: { human: createSeerFixRenderer },
  parameters: {
    positional: issueIdPositional,
    flags: {
      fresh: FRESH_FLAG,
      apply: {
        kind: "boolean",
        brief: "Apply the validated patch batch to the current checkout",
        default: false,
      },
      pr: {
        kind: "boolean",
        brief: "Create or await pull requests for affected repositories",
        default: false,
      },
      instruction: {
        kind: "parsed",
        parse: String,
        brief: "Context for a new fix",
        optional: true,
      },
      "run-id": {
        kind: "parsed",
        parse: String,
        brief: "Resume this Seer run",
        optional: true,
      },
      response: {
        kind: "parsed",
        parse: String,
        brief: "JSON file with input_id and response_data (requires --run-id)",
        optional: true,
      },
      timeout: {
        kind: "parsed",
        parse: parseTimeout,
        brief: "Maximum wait in seconds",
        default: "360",
      },
    },
    aliases: FRESH_ALIASES,
  },
  async *func(this: SentryContext, flags: FixFlags, issueArg: string) {
    applyFreshFlag(flags);
    const runId = flags["run-id"];
    if (flags.response && !runId) {
      throw new ValidationError("--response requires --run-id.", "--response");
    }
    const response = await readResponse(flags.response);
    const interactive = !flags.json && isatty(0) && isatty(2);
    let org: string | undefined;
    const abort = new AbortController();
    const onInterrupt = () => abort.abort();
    process.once("SIGINT", onInterrupt);
    try {
      const resolved = await resolveOrgAndIssueId({
        issueArg,
        cwd: this.cwd,
        command: "fix",
      });
      org = resolved.org;
      const deadline = Date.now() + flags.timeout * 1000;
      const result = await runSeerFix({
        org,
        issueId: resolved.issueId,
        issueArg,
        runId,
        response,
        instruction: flags.instruction,
        timeoutMs: flags.timeout * 1000,
        signal: abort.signal,
        interactive,
        prompt: (input) => promptSeerInput(input, this.stderr),
        onBlocks: interactive
          ? createSeerBlockRenderer(this.stderr)
          : undefined,
      });
      if (["ERROR", "CANCELLED", "TIMEOUT"].includes(result.status)) {
        throw new OutputError(result);
      }
      const canDeliver =
        result.status === "COMPLETED" &&
        result.pending_user_input === null &&
        result.patches.length > 0;
      let choice = { apply: flags.apply, pr: flags.pr };
      let previewed = false;
      if (canDeliver && interactive && !choice.apply && !choice.pr) {
        yield new CommandOutput(result);
        previewed = true;
        choice = await promptSeerDelivery();
      }
      if (!(canDeliver && (choice.apply || choice.pr))) {
        if (!previewed) {
          yield new CommandOutput(result);
        }
        return;
      }
      // JSON callers receive one aggregate document. Human output previews before writes.
      if (!previewed && !flags.json) {
        yield new CommandOutput(result);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || abort.signal.aborted) {
        const timedOut: FixDeliveryResult = {
          ...result,
          status: abort.signal.aborted ? "CANCELLED" : "TIMEOUT",
          next_action: `Delivery did not start. Review the fix with sentry issue fix ${issueArg} --run-id ${result.run_id}.`,
        };
        throw new OutputError(timedOut);
      }
      const delivered = await deliverSeerFix({
        org,
        result,
        cwd: this.cwd,
        apply: choice.apply,
        pr: choice.pr,
        timeoutMs: remaining,
        signal: abort.signal,
      });
      if (
        ["ERROR", "CANCELLED", "TIMEOUT"].includes(delivered.status) ||
        (delivered.delivery_errors?.length ?? 0) > 0
      ) {
        throw new OutputError(delivered);
      }
      yield new CommandOutput(delivered);
    } catch (error) {
      if (error instanceof ApiError) {
        throw handleSeerApiError(error.status, error.detail, org);
      }
      throw error;
    } finally {
      process.removeListener("SIGINT", onInterrupt);
    }
  },
});
