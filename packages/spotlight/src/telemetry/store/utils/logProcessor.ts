import type { SentryLogEvent, SentryLogEventItem } from "../../types.ts";
import { toTimestamp } from "../utils.ts";

export interface LogProcessingResult {
  processedLogs: SentryLogEventItem[];
}

/**
 * Processes log items from a log event, normalizing and enriching them with metadata.
 * @param event The log event to process
 * @param existingLogIds Set of already processed log IDs to avoid duplicates
 * @returns Processed log items ready to be stored
 */
export function processLogItems(
  event: SentryLogEvent,
  existingLogIds: Set<string>,
): LogProcessingResult {
  const processedLogs: SentryLogEventItem[] = [];

  if (!event.items?.length) {
    return { processedLogs };
  }

  for (const [index, logItem] of event.items.entries()) {
    const logId = logItem.id || `${event.event_id}:log:${index}`;

    // Skip if already processed
    if (existingLogIds.has(logId)) {
      continue;
    }

    // Normalize severity number
    if (logItem.severity_number == null) {
      logItem.severity_number = 0;
    }

    // Extract SDK name from attributes
    logItem.sdk = logItem.attributes?.["sentry.sdk.name"]?.value as string;

    // Normalize timestamp
    logItem.timestamp = toTimestamp(logItem.timestamp);
    logItem.id = logId;

    processedLogs.push(logItem);
  }

  return { processedLogs };
}
