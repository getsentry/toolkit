import { setAttribute, setTag } from "@sentry/core";
import { isNumericId } from "../utils/slug-validation";

/**
 * The Sentry resources that a tool call targets. Each field with a value is
 * sent as a tag and an attribute, for example `issueId` as `issue.id`.
 * `targetKeys` holds the key for each field.
 */
export interface Target {
  organizationSlug: string;
  projectSlug?: string | null;
  /** Numeric project ID. */
  projectId?: string | number | null;
  /**
   * Project reference as the user gave it: a numeric value is sent as
   * `project.id`, any other value as `project.slug`.
   */
  projectSlugOrId?: string | null;
  teamSlug?: string | null;
  issueId?: string | null;
  traceId?: string | null;
  /** Span ID inside `traceId`. */
  spanId?: string | null;
  monitorSlug?: string | null;
  uptimeMonitorId?: string | null;
  releaseVersion?: string | null;
  replayId?: string | null;
  profileId?: string | null;
  profilerId?: string | null;
  /** ID of the AI agent conversation that the tool reads. */
  aiConversationId?: string | null;
}

const targetKeys = {
  teamSlug: "team.slug",
  issueId: "issue.id",
  traceId: "trace.id",
  spanId: "trace.span_id",
  monitorSlug: "monitor.slug",
  uptimeMonitorId: "uptime.monitor_id",
  releaseVersion: "release.version",
  replayId: "replay.id",
  profileId: "profile.id",
  profilerId: "profiler.id",
  aiConversationId: "ai_conversation.id",
} as const satisfies Partial<Record<keyof Target, string>>;

/**
 * Sets `key` on the isolation scope as a tag for error events and as an
 * attribute for streamed spans, logs, and metrics. SDK v11 does not copy
 * scope tags onto spans.
 */
function setTagAndAttribute(key: string, value: string): void {
  setAttribute(key, value);
  setTag(key, value);
}

/**
 * Sets each `Target` field that has a value as a tag and as an attribute:
 * `organization.slug`, `project.slug`, `project.id`, and the keys in
 * `targetKeys`. Accepts tool `params` directly when they use these field
 * names.
 */
export function setTargetTagsAndAttributes(target: Target): void {
  const { organizationSlug, projectSlugOrId } = target;
  const isProjectId = projectSlugOrId ? isNumericId(projectSlugOrId) : false;
  const projectSlug =
    target.projectSlug ?? (isProjectId ? undefined : projectSlugOrId);
  const projectId =
    target.projectId ?? (isProjectId ? projectSlugOrId : undefined);

  setTagAndAttribute("organization.slug", organizationSlug);
  if (projectSlug) setTagAndAttribute("project.slug", projectSlug);
  if (projectId != null && projectId !== "") {
    setTagAndAttribute("project.id", String(projectId));
  }
  for (const [field, key] of Object.entries(targetKeys)) {
    const value = target[field as keyof typeof targetKeys];
    if (value) setTagAndAttribute(key, value);
  }
}
