/**
 * sentry token list
 *
 * List an organization's active org auth tokens.
 */

import type { SentryContext } from "../../context.js";
import { listOrgAuthTokens } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { selectAccountForOrg } from "../../lib/db/auth.js";
import { colorTag, escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import { formatRelativeTime } from "../../lib/formatters/time-utils.js";
import { type OrgTarget, orgTarget } from "../../lib/target-positional.js";
import { type OrgAuthToken, OrgAuthTokenSchema } from "../../types/index.js";
import {
  ensureTokenScopes,
  explainTokenForbidden,
  LIST_SCOPES,
} from "./shared.js";

type ListFlags = {
  readonly json: boolean;
  readonly fields?: string[];
};

const TOKEN_COLUMNS: Column<OrgAuthToken>[] = [
  { header: "ID", value: (t) => t.id },
  { header: "NAME", value: (t) => escapeMarkdownCell(t.name) },
  { header: "SCOPES", value: (t) => t.scopes.join(", ") },
  {
    header: "ENDS WITH",
    value: (t) => (t.tokenLastCharacters ? `…${t.tokenLastCharacters}` : ""),
  },
  {
    header: "LAST USED",
    value: (t) =>
      t.dateLastUsed
        ? formatRelativeTime(t.dateLastUsed)
        : colorTag("muted", "never"),
  },
  { header: "CREATED", value: (t) => formatRelativeTime(t.dateCreated) },
];

function formatTokenList(tokens: OrgAuthToken[]): string {
  if (tokens.length === 0) {
    return "No active org auth tokens.";
  }
  return formatTable(tokens, TOKEN_COLUMNS);
}

export const listCommand = buildCommand({
  docs: {
    brief: "List org auth tokens",
    fullDescription:
      "List an organization's active org auth tokens. Sentry never returns a " +
      "token's value after creation, so the list only shows its last characters.\n\n" +
      "Alias: `sentry tokens` → `sentry token list`",
    examples: [
      {
        description: "List tokens (auto-detect org)",
        command: "sentry token list",
      },
      {
        description: "List tokens in a specific org",
        command: "sentry token list my-org",
      },
      { description: "Output as JSON", command: "sentry token list --json" },
    ],
  },
  output: {
    human: formatTokenList,
    schema: OrgAuthTokenSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org",
          brief: "Organization slug (auto-detected if omitted)",
          parse: orgTarget,
          optional: true,
        },
      ],
    },
  },
  async *func(this: SentryContext, _flags: ListFlags, target: OrgTarget) {
    const resolved = await target.resolved;

    selectAccountForOrg(resolved.org);
    const scopeMissing = await ensureTokenScopes(
      LIST_SCOPES,
      "Listing org auth tokens",
    );

    let tokens: OrgAuthToken[];
    try {
      tokens = await listOrgAuthTokens(resolved.org);
    } catch (error) {
      throw explainTokenForbidden(error, LIST_SCOPES, scopeMissing);
    }

    yield new CommandOutput(tokens);
    if (tokens.length === 0) {
      return {
        hint: `Create one with: sentry token create ${resolved.org}/<name>`,
      };
    }
  },
});
