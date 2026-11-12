import type { z } from "zod";
import { ThreadsEntrySchema } from "../../api-client";
import type { SentryApiService, ThreadEntrySchema } from "../../api-client";
import type { Event } from "../../api-client/types";
import {
  formatAvailableThreadList,
  formatThreadStacktraceOutput,
} from "../../internal/formatting";

type Thread = z.infer<typeof ThreadEntrySchema>;
type ThreadSelector = string | number | undefined;

type SelectedThread =
  | {
      kind: "selected";
      thread: Thread;
      reason: string;
    }
  | {
      kind: "not_found" | "ambiguous";
      message: string;
    };

/**
 * Fetches an issue event and formats the selected thread stacktrace.
 */
export async function fetchAndFormatEventStacktrace({
  apiService,
  organizationSlug,
  issueId,
  eventId,
  thread,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  issueId: string;
  eventId: string;
  thread?: string | number;
}): Promise<string> {
  const event = await apiService.getEventForIssue({
    organizationSlug,
    issueId,
    eventId,
  });

  const threads = getThreads(event);

  let output = `# Event Stacktrace in **${organizationSlug}**\n\n`;
  output += `**Issue ID**: ${issueId}\n`;
  output += `**Event ID**: ${event.id}\n\n`;

  if (threads.length === 0) {
    output += "No thread stacktraces were found for this event.\n";
    return output;
  }

  const selected = selectThread(threads, thread);

  if (selected.kind !== "selected") {
    output += `${selected.message}\n\n`;
    output += formatAvailableThreadList(threads);
    return output;
  }

  output += formatThreadStacktraceOutput({
    event,
    thread: selected.thread,
    selectionReason: selected.reason,
  });
  return output;
}

function getThreads(event: Event): Thread[] {
  const threadsEntry = event.entries.find((entry) => entry.type === "threads");
  const result = ThreadsEntrySchema.safeParse(threadsEntry?.data);
  return result.success ? (result.data.values ?? []) : [];
}

function selectThread(
  threads: Thread[],
  selector: ThreadSelector,
): SelectedThread {
  if (selector === undefined) {
    const selected = selectSentryDefaultThread(threads);
    return {
      kind: "selected",
      thread: selected,
      reason:
        "Sentry default selection: first crashed thread, then first thread with a stacktrace, then first thread.",
    };
  }

  if (typeof selector === "number") {
    return selectUnique(
      threads,
      (thread) => String(thread.id) === String(selector),
      `No thread found with ID ${selector}.`,
      `Multiple threads matched ID ${selector}.`,
    );
  }

  const nameMatch = selectUnique(
    threads,
    (thread) => thread.name === selector,
    "",
    `Multiple threads matched name "${selector}".`,
  );
  if (nameMatch.kind !== "not_found") {
    return nameMatch;
  }

  if (/^-?\d+$/.test(selector)) {
    return selectUnique(
      threads,
      (thread) => String(thread.id) === selector,
      `No thread found with name or ID "${selector}".`,
      `Multiple threads matched ID ${selector}.`,
    );
  }

  return {
    kind: "not_found",
    message: `No thread found with name "${selector}".`,
  };
}

// Mirrors Sentry's thread UI default: crashed first, otherwise a thread with a
// stacktrace, otherwise the first available thread.
function selectSentryDefaultThread(threads: Thread[]): Thread {
  const sortedThreads = [...threads].sort(
    (a, b) => Number(Boolean(b.crashed)) - Number(Boolean(a.crashed)),
  );
  return (
    sortedThreads.find((thread) => thread.crashed) ??
    sortedThreads.find((thread) => hasFrames(thread)) ??
    sortedThreads[0]
  );
}

function hasFrames(thread: Thread): boolean {
  return Boolean(thread.stacktrace?.frames.length);
}

function selectUnique(
  threads: Thread[],
  predicate: (thread: Thread) => boolean,
  notFoundMessage: string,
  ambiguousMessage: string,
): SelectedThread {
  const matches = threads.filter(predicate);

  if (matches.length === 0) {
    return { kind: "not_found", message: notFoundMessage };
  }

  if (matches.length > 1) {
    return { kind: "ambiguous", message: ambiguousMessage };
  }

  return {
    kind: "selected",
    thread: matches[0],
    reason: "Matched the provided thread selector.",
  };
}
