/**
 * Default `organizationSlug` for tool calls that omit it, the MCP side of
 * the CLI's missing-context recovery (#1634). When the login reaches exactly
 * one organization, the call uses it. A tool that requires an organization
 * and reaches several fails with a ready-to-run retry and the list, so the
 * caller never gets a guessed organization.
 */
import { inlineCode } from "@sentry/toolkit-core/markdown";
import type { ZodType } from "zod";
import { ApiError } from "../../api-client";
import { UserInputError } from "../../errors";
import { MISSING_ORGANIZATION_SLUG_HINT } from "../../schema";
import type { ToolConfig } from "../../tools/types";
import type { ServerContext } from "../../types";
import { apiServiceFromContext } from "./api";
import {
  getTargetOrganizationSlug,
  listCredentialContexts,
  mapCredentialContexts,
} from "./credential-routing";
import { formatToolCall } from "./tool-call-formatting";

/** Matches the `find_organizations` page size. */
const ORGANIZATION_LIST_LIMIT = 25;
/**
 * Matches the shared response cache's `stable` tier, so a new organization
 * shows up at most this late in a long-lived stdio session.
 */
const ORGANIZATION_LIST_TTL_MS = 5 * 60 * 1000;

type ReachableOrganizations = {
  organizations: Array<{ slug: string; regionUrl: string | null }>;
  hasMore: boolean;
  /** A login's listing failed, so the list may miss organizations. */
  isPartial: boolean;
};

type CachedOrganizations = {
  accessToken: string;
  sentryHost: ServerContext["sentryHost"];
  sentryProtocol: ServerContext["sentryProtocol"];
  expiresAt: number;
  pending: Promise<ReachableOrganizations>;
};

const organizationsCache = new WeakMap<ServerContext, CachedOrganizations>();

type ToolArguments = NonNullable<
  Parameters<typeof formatToolCall>[0]["arguments"]
>;

async function fetchReachableOrganizations(
  context: ServerContext,
): Promise<ReachableOrganizations> {
  const listPage = async (callContext: ServerContext) =>
    await apiServiceFromContext(callContext).listOrganizations({
      limit: ORGANIZATION_LIST_LIMIT,
    });
  // With several logins, an organization any of them reaches counts, and
  // the credential router later picks the login that knows it.
  const accounts = await listCredentialContexts(context);
  const pages = accounts
    ? (
        await mapCredentialContexts(accounts, ({ context: callContext }) =>
          listPage(callContext),
        )
      ).map(({ value }) => value)
    : [await listPage(context)];
  // mapCredentialContexts skips a login whose listing fails.
  const isPartial = accounts !== null && pages.length < accounts.length;

  const organizations = new Map<string, string | null>();
  for (const page of pages) {
    for (const organization of page.organizations) {
      if (!organizations.has(organization.slug)) {
        organizations.set(
          organization.slug,
          organization.links?.regionUrl?.trim() || null,
        );
      }
    }
  }
  return {
    organizations: [...organizations].map(([slug, regionUrl]) => ({
      slug,
      regionUrl,
    })),
    hasMore: pages.some(({ nextCursor }) => nextCursor !== null),
    isPartial,
  };
}

/**
 * The organizations the context's login reaches, listed once per context,
 * credential, and host for {@link ORGANIZATION_LIST_TTL_MS}. A failed or
 * partial listing is not kept.
 */
function getReachableOrganizations(
  context: ServerContext,
): Promise<ReachableOrganizations> {
  const cached = organizationsCache.get(context);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.accessToken === context.accessToken &&
    cached.sentryHost === context.sentryHost &&
    cached.sentryProtocol === context.sentryProtocol
  ) {
    return cached.pending;
  }
  const pending = fetchReachableOrganizations(context);
  const entry: CachedOrganizations = {
    accessToken: context.accessToken,
    sentryHost: context.sentryHost,
    sentryProtocol: context.sentryProtocol,
    expiresAt: Date.now() + ORGANIZATION_LIST_TTL_MS,
    pending,
  };
  organizationsCache.set(context, entry);
  const forget = () => {
    if (organizationsCache.get(context) === entry) {
      organizationsCache.delete(context);
    }
  };
  pending.then(({ isPartial }) => isPartial && forget(), forget);
  return pending;
}

/** Whether a tool's `organizationSlug` schema rejects an omitted value. */
export function isOrganizationSlugRequired(schema: ZodType): boolean {
  return !schema.safeParse(undefined).success;
}

function isMissing(value: unknown): boolean {
  return value == null || (typeof value === "string" && !value.trim());
}

/** Whether `value` is what the tool's schema fills in for an omitted `key`. */
function isDefaultValue(
  tool: ToolConfig<any>,
  key: string,
  value: unknown,
): boolean {
  const omitted = tool.inputSchema[key]?.safeParse(undefined);
  return (
    !!omitted?.success && JSON.stringify(omitted.data) === JSON.stringify(value)
  );
}

/**
 * The same call with `organizationSlug` set, in the form the caller used:
 * a direct tool call, or `execute_sentry_tool` for a catalog tool. The MCP
 * SDK hands direct tools their arguments with defaults applied, so values
 * equal to a default are left out to keep the retry short.
 */
function formatRetry(
  tool: ToolConfig<any>,
  rawParams: Record<string, unknown>,
  organizationSlug: string,
  context: ServerContext,
): string {
  const { organizationSlug: _omitted, ...rest } = rawParams;
  const args = Object.fromEntries(
    Object.entries({ organizationSlug, ...rest }).filter(
      ([key, value]) =>
        value !== undefined && !isDefaultValue(tool, key, value),
    ),
  ) as ToolArguments;
  const isDirect = context.directToolNames?.has(tool.name) ?? true;
  return inlineCode(
    isDirect
      ? formatToolCall({ toolName: tool.name, arguments: args })
      : formatToolCall({
          toolName: "execute_sentry_tool",
          arguments: { name: tool.name, arguments: args },
        }),
  );
}

function formatMultipleOrganizationsError(
  tool: ToolConfig<any>,
  rawParams: Record<string, unknown>,
  reachable: ReachableOrganizations,
  context: ServerContext,
): string {
  const [first = "", ...others] = reachable.organizations.map(
    ({ slug }) => slug,
  );
  const lines = [
    reachable.isPartial
      ? "`organizationSlug` is required: some logins could not list their organizations, so none was picked."
      : "`organizationSlug` is required: you can access more than one organization, so none was picked.",
    "",
    `Retry example: ${formatRetry(tool, rawParams, first, context)}`,
  ];
  if (others.length > 0) {
    lines.push(`Other available organizations: ${others.join(", ")}`);
  }
  if (reachable.isPartial) {
    lines.push(
      "Call `find_organizations()` to check which organizations each login can access.",
    );
  } else if (reachable.hasMore) {
    lines.push(
      "More organizations exist. Use `find_organizations(query='...')` to search them.",
    );
  }
  return lines.join("\n");
}

/**
 * Fill `organizationSlug` when a call omits it and, for a tool where it is
 * optional, names no Sentry URL that carries the organization. Runs after constraint injection, so an
 * org-scoped session never reaches it.
 *
 * - One reachable organization: the call uses it, and its `regionUrl` when
 *   the tool takes one and the caller left it unset.
 * - Several or none: a tool that requires `organizationSlug` fails with the
 *   list and a ready-to-run retry; a tool where it is optional runs as is
 *   and reports what it is missing.
 */
export async function applyDefaultOrganization({
  tool,
  params,
  rawParams,
  context,
}: {
  tool: ToolConfig<any>;
  params: Record<string, unknown>;
  rawParams: Record<string, unknown>;
  context: ServerContext;
}): Promise<Record<string, unknown>> {
  const organizationSchema = tool.inputSchema.organizationSlug;
  if (!organizationSchema || !isMissing(params.organizationSlug)) {
    return params;
  }
  const isRequired = isOrganizationSlugRequired(organizationSchema);
  // A Sentry URL can stand in for an optional slug. A tool that requires the
  // slug never reads it from a URL, and its `url` may be an external one
  // (such as an uptime monitor's target), so only optional slugs check it.
  if (!isRequired && getTargetOrganizationSlug(params) !== null) {
    return params;
  }

  let reachable: ReachableOrganizations;
  try {
    reachable = await getReachableOrganizations(context);
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }
    if (!isRequired) {
      return params;
    }
    // The login cannot list organizations (such as a token without
    // org:read), so fall back to the schema's own recovery hint.
    throw new UserInputError(
      `Invalid arguments for ${tool.name}: organizationSlug: ${MISSING_ORGANIZATION_SLUG_HINT}`,
      { cause: error },
    );
  }

  const [only] = reachable.organizations;
  // Default only from a complete list, so a login that failed to answer
  // cannot hide a second organization.
  if (
    only &&
    reachable.organizations.length === 1 &&
    !reachable.hasMore &&
    !reachable.isPartial
  ) {
    const defaulted: Record<string, unknown> = {
      ...params,
      organizationSlug: only.slug,
    };
    if (
      only.regionUrl &&
      "regionUrl" in tool.inputSchema &&
      isMissing(params.regionUrl)
    ) {
      defaulted.regionUrl = only.regionUrl;
    }
    return defaulted;
  }

  if (!isRequired) {
    return params;
  }
  if (!only && reachable.isPartial) {
    throw new UserInputError(
      `Invalid arguments for ${tool.name}: organizationSlug: ${MISSING_ORGANIZATION_SLUG_HINT}`,
    );
  }
  if (!only) {
    throw new UserInputError(
      "`organizationSlug` is required, and this login cannot access any organization.",
    );
  }
  throw new UserInputError(
    formatMultipleOrganizationsError(tool, rawParams, reachable, context),
  );
}
