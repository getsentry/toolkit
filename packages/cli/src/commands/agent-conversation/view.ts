/**
 * sentry agent-conversation view
 *
 * View the transcript of a specific agent conversation.
 */

import type { SentryContext } from "../../context.js";
import { getConversationSpans } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError, validationError } from "../../lib/errors.js";
import {
  buildTranscriptResult,
  formatTranscriptResult,
  type TranscriptResult,
} from "../../lib/formatters/conversation.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { validateResourceId } from "../../lib/input-validation.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import { resolveOrg } from "../../lib/resolve-target.js";

type ViewFlags = {
  readonly json: boolean;
  readonly fresh: boolean;
};

const USAGE = "[<org>/]<conversation-id>";
const USAGE_HINT = `sentry agent-conversation view ${USAGE}`;

/**
 * Split a `[<org>/]<conversation-id>` positional into its parts.
 *
 * Conversation IDs are org-scoped (not org/project-scoped like trace/replay
 * IDs) and never contain `/`, so the arg has at most one slash: everything
 * before the first `/` is the org, the remainder is the conversation ID. With
 * no slash the whole value is the conversation ID and the org is auto-detected.
 *
 * @throws {ValidationError} When the target contains empty segments or multiple slashes.
 */
function parseConversationTarget(target: string): {
  org?: string;
  conversationId: string;
} {
  const trimmed = target.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx === -1) {
    validateResourceId(trimmed, "conversation ID");
    return { conversationId: trimmed };
  }
  if (slashIdx !== trimmed.lastIndexOf("/")) {
    throw validationError(
      "Conversation target must contain at most one '/'.",
      [USAGE_HINT],
      "conversation-id",
    );
  }
  const org = trimmed.slice(0, slashIdx);
  const conversationId = trimmed.slice(slashIdx + 1);
  if (!(org && conversationId)) {
    throw validationError(
      "Conversation target must include both an organization and conversation ID when using '/'.",
      [USAGE_HINT],
      "conversation-id",
    );
  }
  validateResourceId(org, "organization slug");
  validateResourceId(conversationId, "conversation ID");
  return { org, conversationId };
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View an agent conversation transcript",
    customUsage: [USAGE],
    fullDescription:
      "View the full transcript of an agent conversation.\n\n" +
      "The org is optional and auto-detected from your project context when\n" +
      "omitted. Prefix the ID with an org slug to target a specific org.",
    examples: [
      {
        description: "View full transcript (organization auto-detected)",
        command: "sentry agent-conversation view conv-123",
      },
      {
        description: "Explicit organization",
        command: "sentry agent-conversation view my-org/conv-123",
      },
      {
        description: "JSON output",
        command: "sentry agent-conversation view my-org/conv-123 --json",
      },
    ],
  },
  output: {
    human: formatTranscriptResult,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/conversation-id",
          brief: "Organization slug (optional) and conversation ID",
          parse: String,
        },
      ],
    },
    flags: {
      fresh: FRESH_FLAG,
    },
    aliases: FRESH_ALIASES,
  },
  async *func(this: SentryContext, flags: ViewFlags, target: string) {
    applyFreshFlag(flags);
    const { cwd } = this;

    if (target === undefined) {
      throw new ContextError("Conversation ID", USAGE_HINT, []);
    }
    if (!target.trim()) {
      throw validationError(
        "Conversation ID cannot be empty.",
        [USAGE_HINT],
        "conversation-id",
      );
    }
    const { org: orgArg, conversationId } = parseConversationTarget(target);

    const resolved = await resolveOrg({ org: orgArg, cwd });
    if (!resolved) {
      throw new ContextError("Organization", USAGE_HINT);
    }
    const org = resolved.org;

    const { spans, stats, truncated, title } = await withProgress(
      {
        message: "Fetching conversation spans...",
        json: flags.json,
      },
      () => getConversationSpans(org, conversationId),
    );

    const result = buildTranscriptResult(conversationId, org, spans, {
      stats,
      title,
    });
    result.truncated = truncated;
    yield new CommandOutput<TranscriptResult>(result);
  },
});
