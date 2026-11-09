import {
  ApiClientError,
  ApiServerError,
  ErrorEntrySchema,
  type SentryApiService,
  ThreadsEntrySchema,
} from "../../api-client";
import type { Event } from "../../api-client/types";
import { ConfigurationError } from "../../errors";
import {
  type CodeLocation,
  type Frame,
  findMostRelevantInAppFrame,
} from "../../internal/code-location";
import { logIssue, logWarn } from "../../telem/logging";

const CODE_LOCATION_TIMEOUT_MS = 3000;

/** Resolves a verified source location, omitting optional enrichment failures. */
export async function resolveCodeLocation({
  apiService,
  organizationSlug,
  projectSlug,
  event,
}: {
  apiService: Pick<SentryApiService, "getStacktraceLink">;
  organizationSlug: string;
  projectSlug: string;
  event: Event;
}): Promise<CodeLocation | undefined> {
  const frame = findRelevantFrame(event);
  if (!frame) {
    return undefined;
  }

  const embeddedSourceUrl = getTrustedGitHubSourceUrl(frame.sourceLink);
  if (embeddedSourceUrl) {
    return {
      repository: getGitHubRepository(embeddedSourceUrl),
      path: getString(frame.filename) ?? getString(frame.absPath),
      ...(frame.lineNo !== null && frame.lineNo !== undefined
        ? { line: frame.lineNo }
        : {}),
      url: embeddedSourceUrl,
    };
  }

  const file = getString(frame.filename) ?? getString(frame.absPath);
  if (!file) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CODE_LOCATION_TIMEOUT_MS,
  );

  try {
    const result = await apiService.getStacktraceLink({
      organizationSlug,
      projectSlug,
      file,
      platform: getString(frame.platform) ?? getString(event.platform),
      ...(frame.lineNo !== null && frame.lineNo !== undefined
        ? { lineNo: frame.lineNo }
        : {}),
      absPath: getString(frame.absPath),
      module: getString(frame.module),
      package: getString(frame.package),
      commitId: getString(event.release?.lastCommit?.id),
      groupId: getString(event.groupID),
      sdkName: getString(event.sdk?.name),
      signal: controller.signal,
    });

    const sourceUrl = getHttpUrl(result.sourceUrl);
    const repository = getString(result.config?.repoName);
    const sourcePath = getString(result.sourcePath);
    if (!sourceUrl || !repository || !sourcePath) {
      return undefined;
    }

    return {
      repository,
      path: sourcePath,
      ...(frame.lineNo !== null && frame.lineNo !== undefined
        ? { line: frame.lineNo }
        : {}),
      url: sourceUrl,
    };
  } catch (error) {
    if (!controller.signal.aborted && error instanceof ApiServerError) {
      // Upstream 5xx from the stacktrace-link endpoint only removes optional
      // enrichment; keep it visible as a warning instead of a Sentry issue.
      logWarn("Stacktrace link lookup failed; omitting code location", {
        loggerScope: ["tools", "get-issue-details", "code-location"],
        extra: {
          organizationSlug,
          projectSlug,
          groupId: event.groupID,
          status: error.status,
          message: error.message,
        },
      });
      return undefined;
    }
    if (
      !controller.signal.aborted &&
      !(error instanceof ApiClientError) &&
      !(error instanceof ConfigurationError)
    ) {
      logIssue(error, {
        loggerScope: ["tools", "get-issue-details", "code-location"],
        contexts: {
          request: {
            organizationSlug,
            projectSlug,
            groupId: event.groupID,
          },
        },
      });
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function findRelevantFrame(event: Event): Frame | undefined {
  for (const entry of event.entries) {
    if (entry.type !== "exception") {
      continue;
    }

    const parsed = ErrorEntrySchema.safeParse(entry.data);
    if (!parsed.success) {
      continue;
    }

    const exceptions =
      parsed.data.values ?? (parsed.data.value ? [parsed.data.value] : []);
    const rootException = [...exceptions]
      .reverse()
      .find((exception) => exception?.stacktrace?.frames?.length);
    if (rootException?.stacktrace?.frames) {
      return findMostRelevantInAppFrame(rootException.stacktrace.frames);
    }
  }

  for (const entry of event.entries) {
    if (entry.type !== "threads") {
      continue;
    }

    const parsed = ThreadsEntrySchema.safeParse(entry.data);
    if (!parsed.success) {
      continue;
    }

    const crashedThread = parsed.data.values?.find(
      (thread) => thread.crashed && thread.stacktrace?.frames?.length,
    );
    if (crashedThread?.stacktrace?.frames) {
      return findMostRelevantInAppFrame(crashedThread.stacktrace.frames);
    }
  }

  return undefined;
}

function getHttpUrl(value: unknown): string | undefined {
  const url = getString(value);
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function getTrustedGitHubSourceUrl(value: unknown): string | undefined {
  const url = getHttpUrl(value);
  if (!url) {
    return undefined;
  }

  const parsed = new URL(url);
  return parsed.protocol === "https:" &&
    (parsed.hostname === "github.com" || parsed.hostname === "www.github.com")
    ? url
    : undefined;
}

function getGitHubRepository(sourceUrl: string): string | undefined {
  const [owner, repository] = new URL(sourceUrl).pathname
    .split("/")
    .filter(Boolean);
  return owner && repository ? `${owner}/${repository}` : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
