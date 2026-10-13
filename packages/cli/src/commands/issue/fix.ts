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
  formatSeerFix,
  promptSeerInput,
} from "../../lib/formatters/seer-fix.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { runSeerFix } from "../../lib/seer-fix.js";
import { issueIdPositional, resolveOrgAndIssueId } from "./utils.js";

type FixFlags = {
  readonly json: boolean;
  readonly fresh: boolean;
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
      "Generate code changes for an issue using Seer AI. Review questions and proposed file changes in an interactive terminal.\n\nJSON and non-interactive sessions pause with a run ID and pending input. Resume using --run-id and --response with a JSON file containing input_id and response_data.\n\nCompleted fixes preview diffs. No files are changed locally. Requires Seer coding access, linked repositories, and a signed-in Sentry user.\n\nEach invocation starts a new interactive chat. Use --run-id to resume a specific chat; the issue argument resolves its organization. --instruction supplies context for a new fix.\n\nExamples:\n  sentry issue fix @latest\n  sentry issue fix my-org/CLI-G --instruction 'Preserve compatibility'\n  sentry issue fix my-org/CLI-G --json\n  sentry issue fix my-org/CLI-G --run-id <run> --response answer.json --json",
  },
  output: { human: formatSeerFix },
  parameters: {
    positional: issueIdPositional,
    flags: {
      fresh: FRESH_FLAG,
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
      yield new CommandOutput(result);
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
