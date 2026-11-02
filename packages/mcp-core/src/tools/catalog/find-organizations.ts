import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  type CredentialContext,
  listCredentialContexts,
  mapCredentialContexts,
} from "../../internal/tool-helpers/credential-routing";
import { UserInputError } from "../../errors";
import { ParamCursor, ParamSearchQuery } from "../../schema";
import { ALL_SKILLS } from "../../skills";
import type { ServerContext } from "../../types";

const RESULT_LIMIT = 25;

export const findOrganizationsOutputSchema = z.object({
  organizations: z.array(
    z.object({
      slug: z.string(),
      webUrl: z.string().url().nullable(),
      regionUrl: z.string().url().nullable(),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

type OrganizationResult = z.infer<
  typeof findOrganizationsOutputSchema
>["organizations"][number];

function normalizeUrl(url: string | undefined): string | null {
  return url?.trim() ? url : null;
}

function toResult(organization: {
  slug: string;
  links?: { organizationUrl?: string; regionUrl?: string };
}): OrganizationResult {
  return {
    slug: organization.slug,
    webUrl: normalizeUrl(organization.links?.organizationUrl),
    regionUrl: normalizeUrl(organization.links?.regionUrl),
  };
}

/**
 * With several logins, `nextCursor` carries each account's own cursor,
 * keyed by credential id, so the next page continues every account that
 * has more.
 */
const ACCOUNTS_CURSOR_PREFIX = "accounts:";
const INVALID_CURSOR_MESSAGE =
  "Invalid cursor. Pass the nextCursor returned by the previous find_organizations call.";

function encodeAccountsCursor(cursors: Record<string, string>): string {
  return `${ACCOUNTS_CURSOR_PREFIX}${btoa(JSON.stringify(cursors))}`;
}

function decodeAccountsCursor(cursor: string): Record<string, string> {
  if (!cursor.startsWith(ACCOUNTS_CURSOR_PREFIX)) {
    throw new UserInputError(INVALID_CURSOR_MESSAGE);
  }
  try {
    const parsed: unknown = JSON.parse(
      atob(cursor.slice(ACCOUNTS_CURSOR_PREFIX.length)),
    );
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    }
  } catch {
    // Reported below.
  }
  throw new UserInputError(INVALID_CURSOR_MESSAGE);
}

/**
 * List organizations from every login and merge them. An organization
 * several logins can reach is listed once, under the first of them (the
 * default login first), the same as `sentry org list`.
 */
async function listAcrossAccounts(
  accounts: CredentialContext[],
  query: string | null,
  cursor: string | null,
) {
  const cursors = cursor ? decodeAccountsCursor(cursor) : undefined;
  const pending = cursors
    ? accounts.filter(({ credential }) => Object.hasOwn(cursors, credential.id))
    : accounts;
  const pages = await mapCredentialContexts(
    pending,
    async ({ credential, context }) =>
      await apiServiceFromContext(context).listOrganizations({
        query: query ?? undefined,
        limit: RESULT_LIMIT,
        cursor: cursors?.[credential.id],
      }),
  );
  const organizations: OrganizationResult[] = [];
  const seen = new Set<string>();
  const nextCursors: Record<string, string> = {};
  for (const { entry, value } of pages) {
    for (const organization of value.organizations) {
      if (seen.has(organization.slug)) {
        continue;
      }
      seen.add(organization.slug);
      organizations.push(toResult(organization));
    }
    if (value.nextCursor !== null) {
      nextCursors[entry.credential.id] = value.nextCursor;
    }
  }
  const hasMore = Object.keys(nextCursors).length > 0;
  return {
    organizations,
    hasMore,
    nextCursor: hasMore ? encodeAccountsCursor(nextCursors) : null,
  };
}

export default defineTool({
  name: "find_organizations",
  skills: ALL_SKILLS, // Foundational tool - available to all skills
  requiredScopes: ["org:read"],
  description: [
    "Find organizations that the user has access to in Sentry.",
    "",
    "Use this tool when you need to:",
    "- View organizations in Sentry",
    "- Find an organization's slug to aid other tool requests",
    "- Search for specific organizations by name or slug",
    "",
    `Returns up to ${RESULT_LIMIT} results per page. When hasMore is true, pass the returned nextCursor with the same filters and scope to fetch the next page.`,
  ].join("\n"),
  inputSchema: {
    query: ParamSearchQuery.nullable().default(null),
    cursor: ParamCursor.nullable().default(null),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findOrganizationsOutputSchema,
  async handler(params, context: ServerContext) {
    const accounts = await listCredentialContexts(context);
    // A cursor from a multi-login listing stays on that path even when
    // fewer logins remain; it is never a Sentry page cursor.
    const isAccountsCursor =
      params.cursor?.startsWith(ACCOUNTS_CURSOR_PREFIX) ?? false;
    if (accounts && (accounts.length > 1 || isAccountsCursor)) {
      return structuredResult(
        await listAcrossAccounts(accounts, params.query, params.cursor),
      );
    }
    if (isAccountsCursor) {
      throw new UserInputError(INVALID_CURSOR_MESSAGE);
    }

    // Organizations are listed from the root host, which returns orgs across
    // all regions, so no regionUrl is passed here.
    const apiService = apiServiceFromContext(context);
    const { organizations, nextCursor } = await apiService.listOrganizations({
      query: params.query ?? undefined,
      limit: RESULT_LIMIT,
      cursor: params.cursor ?? undefined,
    });

    return structuredResult({
      organizations: organizations.map(toResult),
      hasMore: nextCursor !== null,
      nextCursor,
    });
  },
});
