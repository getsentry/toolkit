import { ApiClientError, type SentryApiService } from "../../api-client";
import type { Event, SourceMapDebug } from "../../api-client/types";
import { ConfigurationError } from "../../errors";
import { hasJsSourceMapErrors } from "../../internal/concerns";
import { logIssue } from "../../telem/logging";

// The endpoint's p99 in Sentry's own telemetry is under 3s; past that the
// concern falls back to the fix implied by the event's error types.
const SOURCE_MAP_DEBUG_TIMEOUT_MS = 3000;

/**
 * Runs Sentry's source map check for an event whose source maps failed, so
 * the concern can name the cause. Skips healthy events and SDKs the check
 * does not support, and omits the result when the check fails.
 */
export async function maybeFetchSourceMapDebug({
  apiService,
  organizationSlug,
  projectSlug,
  event,
}: {
  apiService: Pick<SentryApiService, "getSourceMapDebug">;
  organizationSlug: string;
  projectSlug: string;
  event: Event;
}): Promise<SourceMapDebug | undefined> {
  // Sentry's UI runs the check only for its JavaScript SDKs
  if (
    !event.sdk?.name?.startsWith("sentry.javascript.") ||
    !hasJsSourceMapErrors(event)
  ) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SOURCE_MAP_DEBUG_TIMEOUT_MS,
  );
  try {
    return await apiService.getSourceMapDebug({
      organizationSlug,
      projectSlug,
      eventId: event.id,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      !controller.signal.aborted &&
      !(error instanceof ApiClientError) &&
      !(error instanceof ConfigurationError)
    ) {
      logIssue(error, {
        loggerScope: ["tools", "get-issue-details", "source-map-debug"],
        contexts: {
          request: { organizationSlug, projectSlug, eventId: event.id },
        },
      });
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
