/**
 * Link and unlink existing external issues through Sentry's native integrations
 * and Sentry Apps. These operations leave the Sentry issue's status unchanged.
 */

import {
  type AppIssueLink,
  findAppIssueLink,
  linkAppIssue,
  listAppIssueLinks,
  resolveAppIssueLink,
  unlinkAppIssueLink,
} from "./api/issue-app-links.js";
import {
  findNativeIssueLink,
  linkNativeIssue,
  listNativeIssueLinks,
  type NativeIssueLink,
  resolveNativeIssueLink,
  unlinkNativeIssueLink,
} from "./api/issue-integrations.js";
import { ValidationError } from "./errors.js";
import { resolveOrgRegion } from "./region.js";
import { invalidateCachedResponsesMatching } from "./response-cache.js";
import { getApiBaseUrl } from "./sentry-client.js";
import { parseHttpUrl } from "./utils.js";

/** An external resource selected for linking to a Sentry issue. */
export type ExternalIssueLinkOptions = {
  /** Organization containing the Sentry issue. */
  orgSlug: string;
  /** Numeric Sentry issue ID. */
  issueId: string;
  /** Project context required by some Sentry App searches. */
  projectId?: string;
  /** URL of an existing external issue. */
  url: string;
  /** Native integration ID, when multiple installations match. */
  integrationId?: string;
  /** Sentry App slug; Linear URLs select the Linear app automatically. */
  appSlug?: string;
  /** Additional fields required by a Sentry App's link form. */
  fields?: Record<string, string>;
  /** Inspect the operation without submitting a mutation. */
  dryRun?: boolean;
};

/** Result shared by human and JSON output for external issue mutations. */
export type ExternalIssueLinkResult = {
  /** Organization containing the Sentry issue. */
  org: string;
  /** Numeric Sentry issue ID. */
  issueId: string;
  /** Requested operation. */
  action: "link" | "unlink";
  /** Whether the external issue remains linked after the operation. */
  linked: boolean;
  /** Whether this invocation changed an association. */
  changed: boolean;
  /** True when no mutation was submitted. */
  dryRun?: boolean;
  /** Canonical external issue identity when available. */
  externalIssue: {
    /** Sentry's internal external-issue record ID, not the tracker key. */
    id?: string;
    /** Tracker key or display name. */
    identifier?: string;
    /** External issue URL. */
    url: string;
    /** Native provider key or Sentry App slug. */
    provider?: string;
  };
};

type ExternalIssueRef = ExternalIssueLinkResult["externalIssue"];

/** A link prepared with reads only: its dry-run preview and the write that creates it. */
type LinkPlan = {
  /** Whether preflight found this association already stored. */
  linked: boolean;
  /** External issue reported by a dry run. */
  preview: ExternalIssueRef;
  /** Submit the link; the backend decides whether it changed anything. */
  submit: () => Promise<{ ref: ExternalIssueRef; changed: boolean }>;
};

/** A stored association matching the requested URL. */
type StoredLink = {
  ref: ExternalIssueRef;
  /** Delete the association, leaving the remote issue untouched. */
  remove: () => Promise<void>;
};

/** Validate the URL and return the Sentry App slug, or undefined for a native integration. */
function selectSentryApp(
  options: ExternalIssueLinkOptions,
): string | undefined {
  const url = parseHttpUrl(options.url);
  if (!url) {
    throw new ValidationError(
      "External issue must be an absolute HTTP(S) URL without credentials.",
      "url",
    );
  }
  const appSlug =
    options.appSlug || (url.hostname === "linear.app" ? "linear" : undefined);
  if (appSlug && options.integrationId) {
    throw new ValidationError(
      "--integration selects a native integration. Use --app for a Sentry App.",
    );
  }
  if (appSlug && options.appSlug === "") {
    throw new ValidationError(
      "Specify --app for this external issue URL",
      "app",
    );
  }
  if (!appSlug && options.fields && Object.keys(options.fields).length > 0) {
    throw new ValidationError(
      "--field requires a Sentry App selected with --app.",
    );
  }
  return appSlug;
}

function appRef(link: AppIssueLink): ExternalIssueRef {
  return {
    id: link.id,
    identifier: link.displayName,
    url: link.webUrl,
    provider: link.serviceType,
  };
}

function nativeRef(link: NativeIssueLink): ExternalIssueRef {
  return {
    id: link.id,
    identifier: link.key,
    url: link.url,
    provider: link.provider,
  };
}

async function planLink(
  options: ExternalIssueLinkOptions,
  appSlug: string | undefined,
): Promise<LinkPlan> {
  if (appSlug) {
    const prepared = await resolveAppIssueLink({ ...options, appSlug });
    return {
      linked: Boolean(prepared.existing),
      preview: {
        id: prepared.existing?.id,
        identifier: prepared.existing?.displayName,
        url: prepared.url,
        provider: prepared.appSlug,
      },
      submit: async () => {
        const { link, changed } = await linkAppIssue(prepared);
        return { ref: appRef(link), changed };
      },
    };
  }
  const prepared = await resolveNativeIssueLink(options);
  return {
    linked: Boolean(prepared.existing),
    preview: {
      id: prepared.existing?.id,
      identifier: prepared.existing?.key,
      url: prepared.url,
      provider: prepared.provider,
    },
    submit: async () => {
      const { link, changed } = await linkNativeIssue(prepared);
      return { ref: nativeRef(link), changed };
    },
  };
}

async function findStoredLink(
  options: ExternalIssueLinkOptions,
  appSlug: string | undefined,
): Promise<StoredLink | undefined> {
  const { orgSlug, issueId, url } = options;
  if (appSlug) {
    const links = await listAppIssueLinks(orgSlug, issueId);
    // Only an explicit --app narrows the match: another App may store a Linear URL.
    const link = findAppIssueLink(links, url, options.appSlug);
    if (!link) {
      return;
    }
    return {
      ref: appRef(link),
      remove: () => unlinkAppIssueLink(orgSlug, issueId, link.id),
    };
  }
  const links = await listNativeIssueLinks(orgSlug, issueId);
  const link = findNativeIssueLink(links, url, options.integrationId);
  if (!link) {
    return;
  }
  return {
    ref: nativeRef(link),
    remove: () => unlinkNativeIssueLink(orgSlug, issueId, link),
  };
}

function toResult(
  options: ExternalIssueLinkOptions,
  action: ExternalIssueLinkResult["action"],
  outcome: Pick<
    ExternalIssueLinkResult,
    "linked" | "changed" | "externalIssue"
  >,
): ExternalIssueLinkResult {
  return {
    org: options.orgSlug,
    issueId: options.issueId,
    action,
    dryRun: options.dryRun,
    ...outcome,
  };
}

/** App callbacks run on the control silo, so invalidate the issue's regional cache too. */
async function invalidateIssueLinks(
  options: ExternalIssueLinkOptions,
): Promise<void> {
  const regionUrl = await resolveOrgRegion(options.orgSlug);
  const base = getApiBaseUrl();
  const issuePath = `/api/0/organizations/${encodeURIComponent(options.orgSlug)}/issues/${encodeURIComponent(options.issueId)}/`;
  await Promise.all([
    invalidateCachedResponsesMatching(new URL(issuePath, regionUrl).href),
    invalidateCachedResponsesMatching(new URL(issuePath, base).href),
    invalidateCachedResponsesMatching(
      new URL(`/api/0/issues/${encodeURIComponent(options.issueId)}/`, base)
        .href,
    ),
  ]);
}

/** Associate an existing ticket; a dry run performs only discovery and validation. */
export async function linkExternalIssue(
  options: ExternalIssueLinkOptions,
): Promise<ExternalIssueLinkResult> {
  const plan = await planLink(options, selectSentryApp(options));
  if (options.dryRun) {
    return toResult(options, "link", {
      linked: plan.linked,
      changed: false,
      externalIssue: plan.preview,
    });
  }
  const { ref, changed } = await plan.submit();
  if (changed) {
    await invalidateIssueLinks(options);
  }
  return toResult(options, "link", {
    linked: true,
    changed,
    externalIssue: ref,
  });
}

/** Remove a stored association without contacting or deleting the remote ticket. */
export async function unlinkExternalIssue(
  options: ExternalIssueLinkOptions,
): Promise<ExternalIssueLinkResult> {
  const appSlug = selectSentryApp(options);
  const link = await findStoredLink(options, appSlug);
  if (link && !options.dryRun) {
    await link.remove();
    await invalidateIssueLinks(options);
  }
  return toResult(options, "unlink", {
    linked: Boolean(link && options.dryRun),
    changed: Boolean(link && !options.dryRun),
    externalIssue: link?.ref ?? { url: options.url, provider: appSlug },
  });
}
