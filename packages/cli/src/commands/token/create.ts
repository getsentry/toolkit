/**
 * sentry token create
 *
 * Create an org auth token (`org:ci`) and print its value. Sentry only
 * returns the value in the create response.
 */

import type { SentryContext } from "../../context.js";
import { createOrgAuthToken } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { parseOrgTarget } from "../../lib/completion-target.js";
import { ContextError } from "../../lib/errors.js";
import {
  escapeMarkdownInline,
  mdKvTable,
  renderMarkdown,
  safeCodeSpan,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import { resolveOrg } from "../../lib/resolve-target.js";
import type { OrgAuthToken } from "../../types/index.js";
import {
  CREATE_SCOPES,
  ensureTokenScopes,
  explainTokenForbidden,
  parseOrgScopedArg,
} from "./shared.js";

const USAGE_HINT = "sentry token create [<org>/]<name>";

type CreateFlags = {
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

type CreateResult =
  | { dryRun: true; org: string; name: string }
  | (OrgAuthToken & { dryRun?: false; org: string });

function formatTokenCreated(result: CreateResult): string {
  if (result.dryRun) {
    return renderMarkdown(
      `Would create org auth token ${safeCodeSpan(result.name)} in **${escapeMarkdownInline(result.org)}**. (dry run)`,
    );
  }
  const rows: [string, string][] = [
    ["Name", escapeMarkdownInline(result.name)],
    ["ID", result.id],
    ["Scopes", result.scopes.join(", ")],
  ];
  if (result.token) {
    rows.push(["Token", safeCodeSpan(result.token)]);
  }
  return renderMarkdown(
    `## Org auth token created in ${escapeMarkdownInline(result.org)}\n\n${mdKvTable(rows)}`,
  );
}

export const createCommand = buildCommand({
  docs: {
    brief: "Create an org auth token",
    fullDescription:
      "Create an org auth token with the org:ci scope, for uploading source maps, " +
      "debug files, and releases from CI.\n\n" +
      "The token value is printed once. Sentry doesn't store it, so save it now.\n\n" +
      "Use `org/name` to pick the org: everything before the first `/` is the org " +
      "slug. Add the org when the name itself contains a `/`.\n\n" +
      "Needs a CLI login (`sentry auth login`). The first run asks you to " +
      "re-authorize so the login can manage org auth tokens (interactive runs " +
      "only; skipped with --json).",
    examples: [
      {
        description: "Create a token (auto-detect org)",
        command: "sentry token create github-actions",
      },
      {
        description: "Create a token in a specific org",
        command: "sentry token create my-org/github-actions",
      },
      {
        description: "Output as JSON, including the token value",
        command: "sentry token create my-org/github-actions --json",
      },
    ],
  },
  output: {
    human: formatTokenCreated,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/name",
          brief: "[<org>/]<name> - Name of the new token",
          parse: parseOrgTarget,
        },
      ],
    },
    flags: {
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: { ...DRY_RUN_ALIASES },
  },
  async *func(this: SentryContext, flags: CreateFlags, target: string) {
    const { value: name, orgSlug } = parseOrgScopedArg(
      target,
      "Token name",
      USAGE_HINT,
    );
    const resolved = await resolveOrg({ org: orgSlug, cwd: this.cwd });
    if (!resolved) {
      throw new ContextError("Organization", USAGE_HINT);
    }
    const { org } = resolved;

    if (flags["dry-run"]) {
      yield new CommandOutput<CreateResult>({ dryRun: true, org, name });
      return { hint: "Dry run — no token was created." };
    }

    const scopeMissing = await ensureTokenScopes(
      CREATE_SCOPES,
      "Creating an org auth token",
    );

    let token: OrgAuthToken;
    try {
      token = await createOrgAuthToken(org, name);
    } catch (error) {
      throw explainTokenForbidden(error, CREATE_SCOPES, scopeMissing);
    }

    yield new CommandOutput<CreateResult>({ ...token, org });
    return {
      hint: "Save the token now. Sentry can't show it again.",
    };
  },
});
