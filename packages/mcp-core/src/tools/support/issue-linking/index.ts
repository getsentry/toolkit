/** Select native integrations locally; Sentry owns URL validation and link mutations. */
import type { SentryApiService } from "../../../api-client";
import type { IssueIntegration } from "../../../api-client/types";
import { UserInputError } from "../../../errors";
import type { AppIssueLinkParams } from "./app";
import { inferAppSlug, linkAppIssue, unlinkAppIssue } from "./app";

export type IssueLinkParams = AppIssueLinkParams & {
  integrationId?: string;
};

export type IssueLinkResult = {
  url: string;
  displayName?: string;
  provider?: string;
  status: "linked" | "already_linked" | "not_linked";
};

function parseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      [...value].some(
        (character) => character.charCodeAt(0) <= 32 || character === "\\",
      )
    ) {
      throw new Error("Invalid URL");
    }
    const path = pathOf(url);
    if (
      /[\\?#]/.test(path) ||
      path
        .split("/")
        .slice(1)
        .some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Invalid URL path");
    }
    return url;
  } catch {
    throw new UserInputError(
      "Provide a valid HTTP(S) external issue URL without credentials.",
    );
  }
}

function pathOf(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/\/+$/, "");
}

function integrationDomain(integration: IssueIntegration): URL | undefined {
  const value = integration.domainName;
  if (!value) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return undefined;
  }
}

function azureAccount(url: URL): string | undefined {
  if (url.hostname === "dev.azure.com")
    return pathOf(url).split("/")[1]?.toLowerCase();
  if (url.hostname.endsWith(".visualstudio.com")) {
    return url.hostname.slice(0, -".visualstudio.com".length);
  }
  return undefined;
}

/** Compare references, ignoring presentation-only URL components. */
function nativeIdentity(
  url: URL,
  provider: string,
  linkedUrl: URL,
): string | undefined {
  const path = pathOf(url);
  switch (provider) {
    case "github":
    case "github_enterprise": {
      const match = path.match(
        /^\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)(?:\/(files|changes|commits|checks))?$/,
      );
      if (!match || (match[2] === "issues" && match[4])) return undefined;
      return `${url.origin}/${match[1]!.toLowerCase()}#${match[3]}`;
    }
    case "gitlab": {
      const match = path.match(/^\/(.+?)(?:\/-)?\/issues\/(\d+)$/);
      return match ? `${url.origin}/${match[1]}#${match[2]}` : undefined;
    }
    case "bitbucket": {
      const match = path.match(/^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/[^/]+)?$/);
      return match ? `${url.origin}/${match[1]}#${match[2]}` : undefined;
    }
    case "jira":
    case "jira_server": {
      // Sentry returns canonical /browse/ URLs. Their prefix preserves the
      // Jira Server context path, which integration.domainName can omit.
      const basePath = linkedUrl.pathname.match(
        /^(.*)\/browse\/[^/]+\/?$/,
      )?.[1];
      if (
        basePath === undefined ||
        url.origin !== linkedUrl.origin ||
        (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
      ) {
        return undefined;
      }
      const issueKey = /^[a-z][a-z\d]*-\d+$/i;
      const segments = url.pathname
        .slice(basePath.length)
        .split("/")
        .filter(Boolean);
      // Keep selectedIssue precedence aligned with Sentry's parse_jira_issue_key.
      const key =
        url.searchParams
          .getAll("selectedIssue")
          .find((value) => issueKey.test(value)) ??
        (["browse", "issues"].includes(segments.at(-2) ?? "") &&
        issueKey.test(segments.at(-1) ?? "")
          ? segments.at(-1)
          : undefined);
      return key ? `${url.origin}${basePath}/${key.toUpperCase()}` : undefined;
    }
    case "vsts": {
      const account = azureAccount(url);
      const accountPath =
        url.hostname === "dev.azure.com" ? path.replace(/^\/[^/]+/, "") : path;
      const match = accountPath.match(
        /^\/(?:[^/]+\/)?_workitems\/edit\/(\d+)$/,
      );
      return account && match
        ? `${url.protocol}//${account}:${url.port}#${match[1]}`
        : undefined;
    }
    default:
      return undefined;
  }
}

function matchesIntegration(url: URL, integration: IssueIntegration): boolean {
  if (integration.status && integration.status !== "active") return false;
  const provider = integration.provider.key;
  const domain = integrationDomain(integration);
  const path = pathOf(url);
  const owner = path.split("/")[1];

  switch (provider) {
    case "github":
    case "github_enterprise": {
      if (provider === "github" && url.host !== "github.com") return false;
      if (provider === "github_enterprise" && !domain) return false;
      if (domain && domain.host !== url.host) return false;
      const installedOwner = domain
        ? pathOf(domain).split("/")[1] || integration.name
        : integration.name;
      return owner?.toLowerCase() === installedOwner.toLowerCase();
    }
    case "bitbucket": {
      if (url.host !== "bitbucket.org") return false;
      // Older personal installations store only the username as domainName.
      const installedOwner =
        domain?.host === "bitbucket.org"
          ? pathOf(domain).split("/")[1]
          : integration.name;
      return owner?.toLowerCase() === installedOwner?.toLowerCase();
    }
    case "vsts":
      return (
        !!domain &&
        !!azureAccount(url) &&
        azureAccount(url) === azureAccount(domain) &&
        url.port === domain.port
      );
    case "gitlab": {
      if (!domain || domain.host !== url.host) return false;
      const group = pathOf(domain);
      // domainName omits a self-hosted instance's deployment prefix. The
      // backend validates its base URL; matching groups stay ambiguous.
      return !group || path.includes(`${group}/`);
    }
    case "jira":
    case "jira_server": {
      if (!domain || domain.host !== url.host) return false;
      const prefix = pathOf(domain);
      return !prefix || path === prefix || path.startsWith(`${prefix}/`);
    }
    default:
      return false;
  }
}

async function nativeCandidates(
  apiService: SentryApiService,
  params: IssueLinkParams,
  url: URL,
): Promise<IssueIntegration[]> {
  const integrations = await apiService.listIssueIntegrations(params);
  const candidates = integrations.filter(
    (integration) =>
      (!params.integrationId ||
        String(integration.id) === params.integrationId) &&
      matchesIntegration(url, integration),
  );
  if (params.integrationId && !candidates.length) {
    throw new UserInputError(
      "The selected integration does not match the external issue URL or is not active.",
    );
  }
  return candidates;
}

function describeIntegrations(integrations: IssueIntegration[]): string {
  return integrations
    .slice(0, 5)
    .map(
      (integration) =>
        `${integration.id} (${integration.name.slice(0, 60)}, ${integration.provider.key})`,
    )
    .join("; ");
}

function validatedParams(params: IssueLinkParams): {
  params: IssueLinkParams;
  url: URL;
} {
  const externalIssueUrl = params.externalIssueUrl.trim();
  const url = parseUrl(externalIssueUrl);
  const appSlug = params.appSlug ?? inferAppSlug(externalIssueUrl);
  if (appSlug && params.integrationId) {
    throw new UserInputError(
      "Provide either appSlug or integrationId to select an integration.",
    );
  }
  if (!appSlug && params.fields !== undefined) {
    throw new UserInputError(
      "fields are only supported for Sentry App links. Provide appSlug to select an App.",
    );
  }
  return { params: { ...params, externalIssueUrl, appSlug }, url };
}

/** Link a reference to a resolved numeric Sentry issue, preserving the backend's no-op result. */
export async function linkExternalIssue(
  apiService: SentryApiService,
  input: IssueLinkParams,
): Promise<IssueLinkResult> {
  const { params, url } = validatedParams(input);
  if (params.appSlug) return linkAppIssue(apiService, params);
  const candidates = await nativeCandidates(apiService, params, url);
  if (!candidates.length) {
    throw new UserInputError(
      "No active issue integration matches this URL. Use a supported issue or pull request URL, or provide appSlug for a Sentry App.",
    );
  }
  if (candidates.length > 1) {
    throw new UserInputError(
      `Multiple installed issue integrations match this URL. Provide integrationId to select one: ${describeIntegrations(candidates)}.`,
    );
  }
  const integration = candidates[0]!;
  const { issue, changed } = await apiService.linkNativeExternalIssue({
    ...params,
    integrationId: String(integration.id),
  });
  return {
    url: issue.url || params.externalIssueUrl,
    displayName: issue.displayName || issue.key,
    provider: integration.provider.key,
    status: changed ? "linked" : "already_linked",
  };
}

/** Find the stored association by URL, then delete it by its internal Sentry ID. */
export async function unlinkExternalIssue(
  apiService: SentryApiService,
  input: IssueLinkParams,
): Promise<IssueLinkResult> {
  const { params, url } = validatedParams(input);
  if (params.appSlug) return unlinkAppIssue(apiService, params);
  // Existing associations can outlive a disabled or reconfigured installation.
  // Match their stored URL, without applying link-time installation eligibility.
  const integrations = await apiService.listIssueIntegrations(params);
  const candidates = integrations.filter(
    (integration) =>
      !params.integrationId || String(integration.id) === params.integrationId,
  );
  if (params.integrationId && !candidates.length) {
    throw new UserInputError(
      "The selected integration was not found on this issue.",
    );
  }
  const matches = candidates.flatMap((integration) =>
    integration.externalIssues.flatMap((issue) => {
      if (!issue.url) return [];
      let existing: URL;
      try {
        existing = parseUrl(issue.url);
      } catch {
        return [];
      }
      const identity = nativeIdentity(url, integration.provider.key, existing);
      return identity &&
        nativeIdentity(existing, integration.provider.key, existing) ===
          identity
        ? [{ integration, issue }]
        : [];
    }),
  );
  if (matches.length > 1) {
    throw new UserInputError(
      `Multiple linked issues match this URL. Provide integrationId to select one: ${describeIntegrations(matches.map(({ integration }) => integration))}.`,
    );
  }
  const match = matches[0];
  if (!match) {
    // Custom Apps can own any URL, including one with a native provider shape.
    if (!params.integrationId) return unlinkAppIssue(apiService, params);
    return { url: params.externalIssueUrl, status: "not_linked" };
  }
  await apiService.unlinkNativeExternalIssue({
    ...params,
    integrationId: String(match.integration.id),
    externalIssueId: String(match.issue.id),
  });
  return {
    url: match.issue.url || params.externalIssueUrl,
    displayName: match.issue.displayName || match.issue.key,
    provider: match.integration.provider.key,
    status: "not_linked",
  };
}
