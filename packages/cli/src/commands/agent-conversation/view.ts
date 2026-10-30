/**
 * sentry agent-conversation view
 *
 * View the transcript of a specific agent conversation.
 */

import type { SentryContext } from "../../context.js";
import { getConversationSpans } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import {
  buildTranscriptResult,
  formatTranscriptResult,
  type TranscriptResult,
} from "../../lib/formatters/conversation.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { ValidationError } from "../../lib/errors.js";
import { ID_KINDS, parseIdArguments } from "../../lib/id-arguments.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { withProgress } from "../../lib/polling.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../lib/positional-parse.js";
import {
  type OrgInput,
  parseOrgInput,
  resolveOrgInput,
} from "../../lib/target-positional.js";

type ViewFlags = {
  readonly json: boolean;
  readonly fresh: boolean;
};

const USAGE = "[<org>/]<conversation-id>";
const USAGE_HINT = `sentry agent-conversation view ${USAGE}`;

const log = logger.withTag("agent-conversation.view");

/** Parsed `agent-conversation view` arguments. */
export type ConversationInput = {
  readonly conversationId: string;
  /** The org to look the conversation up in */
  readonly org: OrgInput;
  /** Warnings to log, such as for reversed arguments */
  readonly warnings: readonly string[];
};

/** A conversation ID and the org it is in. */
export type ResolvedConversation = {
  readonly org: string;
  readonly conversationId: string;
};

/** The arguments of `agent-conversation view`. */
export type ConversationArguments = BoundArguments<
  ConversationInput,
  ResolvedConversation
>;

/**
 * Parse `[<org>/]<conversation-id>` in the forms every ID-taking command
 * takes (see `id-arguments.ts`). Conversation IDs are org-scoped, so a
 * project is rejected. Has no side effects.
 *
 * A conversation ID is opaque, so any word may be one: of two words, the
 * first is the org (`<org> <conversation-id>`), as no reversed order can be
 * told apart.
 *
 * @throws {ContextError} When no conversation ID is given
 * @throws {ValidationError} When the ID or org is malformed, a project is
 *   given, or there are more arguments than an org and an ID
 */
export function parseConversationArguments(
  args: readonly string[],
): ConversationInput {
  const parsed = parseIdArguments(args, ID_KINDS.conversation, {
    usageHint: USAGE_HINT,
    multiple: true,
  });
  let { target, ids } = parsed;
  if (target === undefined && ids.length === 2) {
    target = `${ids[0]}/`;
    ids = ids.slice(1);
  }
  if (ids.length > 1) {
    throw new ValidationError(
      `View one conversation at a time: ${USAGE_HINT}`,
      "conversation-id",
    );
  }
  const [conversationId = ""] = ids;
  const org = parseOrgInput(target, USAGE_HINT);
  return {
    conversationId,
    org: parsed.baseUrl ? { ...org, baseUrl: parsed.baseUrl } : org,
    warnings: parsed.warnings,
  };
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
    positional: boundArguments({
      placeholder: "org/conversation-id",
      brief: "Organization slug (optional) and conversation ID",
      kind: "org",
      parse: parseConversationArguments,
      resolve: async (
        input,
        context: SentryContext,
      ): Promise<ResolvedConversation> => {
        for (const warning of input.warnings) {
          log.warn(warning);
        }
        const { org } = await resolveOrgInput(
          input.org,
          context.cwd,
          USAGE_HINT,
        );
        return { org, conversationId: input.conversationId };
      },
    }),
    flags: {
      fresh: FRESH_FLAG,
    },
    aliases: FRESH_ALIASES,
  },
  async *func(
    this: SentryContext,
    flags: ViewFlags,
    target: ConversationArguments,
  ) {
    applyFreshFlag(flags);
    const { org, conversationId } = await target.resolved;

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
