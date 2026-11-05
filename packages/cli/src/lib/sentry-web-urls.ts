/** Credential-aware web links without importing auth into the pure URL helpers. */
import { getApiBaseUrl } from "./sentry-client.js";
import {
  buildBillingUrl as buildBillingUrlPure,
  buildDashboardsListUrl as buildDashboardsListUrlPure,
  buildDashboardUrl as buildDashboardUrlPure,
  buildEventSearchUrl as buildEventSearchUrlPure,
  buildAlertsUrl as buildAlertsUrlPure,
  buildIssueUrl as buildIssueUrlPure,
  buildLogsUrl as buildLogsUrlPure,
  buildMonitorsUrl as buildMonitorsUrlPure,
  buildOrgSettingsUrl as buildOrgSettingsUrlPure,
  buildOrgUrl as buildOrgUrlPure,
  buildProjectIssuesUrl as buildProjectIssuesUrlPure,
  buildProjectUrl as buildProjectUrlPure,
  buildReleaseUrl as buildReleaseUrlPure,
  buildReplayUrl as buildReplayUrlPure,
  buildRepositorySettingsUrl as buildRepositorySettingsUrlPure,
  buildSeerSettingsUrl as buildSeerSettingsUrlPure,
  buildSourceCodeIntegrationsUrl as buildSourceCodeIntegrationsUrlPure,
  buildTraceUrl as buildTraceUrlPure,
  getOrgBaseUrl as getOrgBaseUrlPure,
  getSentryBaseUrl as getSentryBaseUrlPure,
  isSaaS as isSaaSPure,
  withSentryBaseUrl,
} from "./sentry-urls.js";

function render<T>(build: () => T): T {
  return withSentryBaseUrl(getApiBaseUrl(), build);
}

export function getSentryBaseUrl(): string {
  return render(getSentryBaseUrlPure);
}

export function isSaaS(): boolean {
  return render(isSaaSPure);
}

export function getOrgBaseUrl(orgSlug: string): string {
  return render(() => getOrgBaseUrlPure(orgSlug));
}

export function buildOrgUrl(orgSlug: string): string {
  return render(() => buildOrgUrlPure(orgSlug));
}

export function buildProjectUrl(orgSlug: string, projectSlug: string): string {
  return render(() => buildProjectUrlPure(orgSlug, projectSlug));
}

export function buildIssueUrl(orgSlug: string, issueId: string): string {
  return render(() => buildIssueUrlPure(orgSlug, issueId));
}

export function buildEventSearchUrl(orgSlug: string, eventId: string): string {
  return render(() => buildEventSearchUrlPure(orgSlug, eventId));
}

export function buildProjectIssuesUrl(
  orgSlug: string,
  projectId?: string,
): string {
  return render(() => buildProjectIssuesUrlPure(orgSlug, projectId));
}

export function buildOrgSettingsUrl(orgSlug: string, hash?: string): string {
  return render(() => buildOrgSettingsUrlPure(orgSlug, hash));
}

export function buildSeerSettingsUrl(orgSlug: string): string {
  return render(() => buildSeerSettingsUrlPure(orgSlug));
}

export function buildRepositorySettingsUrl(orgSlug: string): string {
  return render(() => buildRepositorySettingsUrlPure(orgSlug));
}

export function buildSourceCodeIntegrationsUrl(orgSlug: string): string {
  return render(() => buildSourceCodeIntegrationsUrlPure(orgSlug));
}

export function buildBillingUrl(orgSlug: string, product?: string): string {
  return render(() => buildBillingUrlPure(orgSlug, product));
}

export function buildLogsUrl(orgSlug: string, logId?: string): string {
  return render(() => buildLogsUrlPure(orgSlug, logId));
}

export function buildReplayUrl(orgSlug: string, replayId: string): string {
  return render(() => buildReplayUrlPure(orgSlug, replayId));
}

export function buildDashboardsListUrl(orgSlug: string): string {
  return render(() => buildDashboardsListUrlPure(orgSlug));
}

export function buildDashboardUrl(
  orgSlug: string,
  dashboardId: string,
): string {
  return render(() => buildDashboardUrlPure(orgSlug, dashboardId));
}

export function buildTraceUrl(orgSlug: string, traceId: string): string {
  return render(() => buildTraceUrlPure(orgSlug, traceId));
}

export function buildAlertsUrl(orgSlug: string, alertId?: string): string {
  return render(() => buildAlertsUrlPure(orgSlug, alertId));
}

export function buildMonitorsUrl(orgSlug: string, monitorId?: string): string {
  return render(() => buildMonitorsUrlPure(orgSlug, monitorId));
}

export function buildReleaseUrl(orgSlug: string, version: string): string {
  return render(() => buildReleaseUrlPure(orgSlug, version));
}
