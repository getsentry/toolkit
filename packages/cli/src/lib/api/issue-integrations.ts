/** Existing issue-tracker links through Sentry's native integrations. */
import {
  type ExternalIssueLinkResponse,
  type IssueIntegrationsResponse,
  listOrganizationIssueIntegrations,
  updateOrganizationIssueIntegration,
} from "@sentry/api";
import {
  vExternalIssueLinkResponse,
  vIssueIntegrationsResponse,
} from "@sentry/api/valibot";
import { safeParse } from "valibot";
import { ApiError, ValidationError } from "../errors.js";
import { resolveOrgRegion } from "../region.js";
import { getSdkConfig } from "../sentry-client.js";
import { parseHttpUrl } from "../utils.js";
import {
  API_MAX_PER_PAGE,
  fetchAllPages,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";

/** An existing reference to a tracker issue, stored by a native integration. */
export type NativeIssueLink = Pick<
  ExternalIssueLinkResponse,
  "key" | "url" | "displayName"
> & {
  /** Internal Sentry ExternalIssue ID. */
  id: string;
  /** ID of the installed Sentry integration that owns this reference. */
  integrationId: string;
  /** Native integration provider key, such as github or jira_server. */
  provider: string;
  /** Issue title, when supplied by the list endpoint. */
  title?: string;
};

type NativeIntegration = IssueIntegrationsResponse[number];

/** Read-only resolution result used for previews and a subsequent link mutation. */
export type PreparedNativeIssueLink = {
  /** Sentry organization containing the source issue. */
  orgSlug: string;
  /** Numeric Sentry issue ID. */
  issueId: string;
  /** Regional API origin resolved for this organization. */
  regionUrl: string;
  /** Selected native integration ID. */
  integrationId: string;
  /** Native integration provider key. */
  provider: string;
  /** External issue URL submitted to the backend for provider resolution. */
  url: string;
  /** Reference found during preflight, used only to describe a dry run. */
  existing?: NativeIssueLink;
};

const TRAILING_SLASH = /\/+$/;
const REPOSITORY_ISSUE = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/[^/]+)?$/;
const GITHUB_PULL_REQUEST = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/[^/]+)?$/;
const GITLAB_ISSUE = /^\/(.+?)(?:\/-)?\/issues\/(\d+)$/;
const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/i;
const JIRA_PATH = /\/(?:browse|issues)\/([A-Z][A-Z0-9]*-\d+)$/i;
const JIRA_CANONICAL_PATH = /^(.*)\/browse\/([^/]+)$/;
const WORK_ITEM = /^(.*?)\/_workitems\/edit\/(\d+)$/;

function parseUrl(value: string): URL {
  const url = storedUrl(value);
  if (!url) {
    throw new ValidationError(
      "External issue must be an absolute HTTP(S) URL without credentials.",
      "url"
    );
  }
  return url;
}

/** Invalid stored URLs must not prevent matching an unrelated valid association. */
function storedUrl(value: string): URL | undefined {
  const url = parseHttpUrl(value);
  if (!url) {
    return;
  }
  url.hash = "";
  url.pathname = url.pathname.replace(TRAILING_SLASH, "");
  return url;
}

function integrationUrl(integration: NativeIntegration): URL | undefined {
  const domain = integration.domainName;
  if (!domain) {
    return integration.provider.key === "github"
      ? storedUrl(`https://github.com/${integration.name}`)
      : undefined;
  }
  // Older personal Bitbucket installations store only the username.
  if (integration.provider.key === "bitbucket" && !domain.includes("/")) {
    return storedUrl(`https://bitbucket.org/${domain}`);
  }
  return storedUrl(domain.includes("://") ? domain : `https://${domain}`);
}

function azureAccount(url: URL): string | undefined {
  if (url.hostname === "dev.azure.com") {
    return url.pathname.split("/").find(Boolean)?.toLowerCase();
  }
  if (url.hostname.endsWith(".visualstudio.com")) {
    return url.hostname.slice(0, -".visualstudio.com".length);
  }
}

/** Jira copy links can select the issue in a path or board/backlog query. */
function jiraIssueKey(url: URL): string | undefined {
  const selected = url.searchParams
    .getAll("selectedIssue")
    .find((key) => JIRA_KEY.test(key));
  return (selected ?? JIRA_PATH.exec(url.pathname)?.[1])?.toUpperCase();
}

/** Compare URL aliases locally; provider identifiers are resolved by the backend. */
function issueIdentity(url: URL, provider: string): string | undefined {
  switch (provider) {
    case "github":
    case "github_enterprise":
    case "bitbucket": {
      const pull =
        provider === "bitbucket"
          ? null
          : GITHUB_PULL_REQUEST.exec(url.pathname);
      const match = pull ?? REPOSITORY_ISSUE.exec(url.pathname);
      return match
        ? `${url.host}/${match[1]?.toLowerCase()}#${match[2]}`
        : undefined;
    }
    case "gitlab": {
      const match = GITLAB_ISSUE.exec(url.pathname);
      return match
        ? `${url.host}/${match[1]?.toLowerCase()}#${match[2]}`
        : undefined;
    }
    case "vsts": {
      const account = azureAccount(url);
      const match = WORK_ITEM.exec(url.pathname);
      return account && match
        ? `${account}:${url.port}#${match[2]}`
        : undefined;
    }
    default:
      return;
  }
}

function matchesIntegration(
  url: URL,
  integration: NativeIntegration,
  explicitlySelected: boolean
): boolean {
  const provider = integration.provider.key;
  // Older Enterprise metadata may omit its host. Only an explicit selection
  // can delegate host validation to the backend's instance_hostname metadata.
  if (provider === "github_enterprise" && !integration.domainName) {
    return (
      explicitlySelected &&
      url.pathname.split("/")[1]?.toLowerCase() ===
        integration.name.toLowerCase()
    );
  }
  const domain = integrationUrl(integration);
  if (!domain) {
    return false;
  }
  if (provider === "vsts") {
    const account = azureAccount(url);
    return Boolean(account) && account === azureAccount(domain);
  }
  if (domain.host !== url.host) {
    return false;
  }
  if (["github", "github_enterprise", "bitbucket"].includes(provider)) {
    const account = domain.pathname.split("/").find(Boolean);
    return (
      !account ||
      url.pathname.split("/")[1]?.toLowerCase() === account.toLowerCase()
    );
  }
  if (provider === "jira" || provider === "jira_server") {
    const prefix = domain.pathname.replace(TRAILING_SLASH, "");
    return (
      !prefix ||
      url.pathname === prefix ||
      url.pathname.startsWith(`${prefix}/`)
    );
  }
  // GitLab's public domain omits its deployment prefix. The backend validates
  // that prefix and group; multiple installations on the host require a selector.
  return provider === "gitlab";
}

/** Read every integration page; partial discovery could hide an ambiguous match. */
async function listIntegrations(
  orgSlug: string,
  issueId: string
): Promise<NativeIntegration[]> {
  const config = getSdkConfig(await resolveOrgRegion(orgSlug));
  return fetchAllPages(
    async (cursor) => {
      const result = await listOrganizationIssueIntegrations({
        ...config,
        path: { organization_id_or_slug: orgSlug, issue_id: issueId },
        query: { cursor, per_page: API_MAX_PER_PAGE },
      });
      return unwrapPaginatedResult(result, "Failed to list issue integrations");
    },
    vIssueIntegrationsResponse,
    "listing issue integrations"
  );
}

function flattenLinks(integrations: NativeIntegration[]): NativeIssueLink[] {
  return integrations.flatMap((integration) =>
    integration.externalIssues.flatMap((link) => {
      const url = storedUrl(link.url);
      if (!url) {
        return [];
      }
      return [
        {
          id: link.id,
          key: link.key,
          displayName: link.displayName,
          title: link.title ?? undefined,
          integrationId: integration.id,
          provider: integration.provider.key,
          url: url.href,
        },
      ];
    })
  );
}

function matchesNativeUrl(link: NativeIssueLink, target: URL): boolean {
  const existing = storedUrl(link.url);
  if (!existing) {
    return false;
  }
  if (["jira", "jira_server"].includes(link.provider)) {
    // Sentry returns /browse/ URLs whose prefix preserves the installation's
    // context path, including contexts omitted from integration.domainName.
    const canonical = JIRA_CANONICAL_PATH.exec(existing.pathname);
    const context = canonical?.[1];
    return (
      existing.host === target.host &&
      context !== undefined &&
      (target.pathname === context ||
        target.pathname.startsWith(`${context}/`)) &&
      jiraIssueKey(target) === canonical?.[2]?.toUpperCase()
    );
  }
  const identity = issueIdentity(target, link.provider);
  if (identity) {
    return identity === issueIdentity(existing, link.provider);
  }
  return existing.href === target.href;
}

/** Match local link metadata without contacting the issue tracker. */
export function findNativeIssueLink(
  links: NativeIssueLink[],
  url: string,
  integrationId?: string
): NativeIssueLink | undefined {
  const target = parseUrl(url);
  const matches = links.filter(
    (link) =>
      (!integrationId || integrationId === link.integrationId) &&
      matchesNativeUrl(link, target)
  );
  if (matches.length > 1) {
    throw new ValidationError(
      "This issue is linked through multiple integrations. Specify --integration <id>."
    );
  }
  return matches[0];
}

/** Select the one active installation that can own the URL; ambiguity requires --integration. */
export function selectNativeIntegration(
  integrations: NativeIntegration[],
  url: string,
  integrationId?: string
): NativeIntegration {
  const target = parseUrl(url);
  const candidates = integrations.filter(
    (integration) =>
      integration.status === "active" &&
      (!integrationId || integrationId === integration.id) &&
      matchesIntegration(target, integration, Boolean(integrationId))
  );
  if (candidates.length === 0) {
    throw new ValidationError(
      "No installed native issue-tracker integration matches this URL. Check --integration, or use --app <slug> for a Sentry App."
    );
  }
  if (candidates.length > 1) {
    throw new ValidationError(
      `Multiple integrations match this URL. Specify --integration <id>: ${candidates.map((integration) => `${integration.id} (${integration.name})`).join(", ")}`
    );
  }
  const selected = candidates[0];
  if (!selected) {
    throw new ValidationError("No matching integration.");
  }
  return selected;
}

/** Prepare a reference using installed integration metadata; performs no mutations. */
export async function resolveNativeIssueLink(options: {
  orgSlug: string;
  issueId: string;
  url: string;
  integrationId?: string;
}): Promise<PreparedNativeIssueLink> {
  const url = parseUrl(options.url);
  const integrations = await listIntegrations(options.orgSlug, options.issueId);
  const selected = selectNativeIntegration(
    integrations,
    url.href,
    options.integrationId
  );
  return {
    orgSlug: options.orgSlug,
    issueId: options.issueId,
    regionUrl: await resolveOrgRegion(options.orgSlug),
    integrationId: selected.id,
    provider: selected.provider.key,
    url: url.href,
    existing: findNativeIssueLink(
      flattenLinks(integrations),
      url.href,
      selected.id
    ),
  };
}

/** Link by URL; the backend resolves provider identifiers and enforces idempotency. */
export async function linkNativeIssue(
  prepared: PreparedNativeIssueLink
): Promise<{ link: NativeIssueLink; changed: boolean }> {
  const result = await updateOrganizationIssueIntegration({
    ...getSdkConfig(prepared.regionUrl),
    path: {
      organization_id_or_slug: prepared.orgSlug,
      issue_id: prepared.issueId,
      integration_id: prepared.integrationId,
    },
    body: { externalIssue: prepared.url },
  });
  const parsed = safeParse(
    vExternalIssueLinkResponse,
    unwrapResult<unknown>(result, "Failed to link external issue")
  );
  if (!parsed.success) {
    throw new ApiError(
      "Unexpected response format after linking; inspect the current links before retrying",
      0
    );
  }
  const data = parsed.output;
  return {
    link: {
      ...data,
      id: String(data.id),
      integrationId: String(data.integrationId),
      provider: prepared.provider,
    },
    changed: result.response.status === 201,
  };
}
