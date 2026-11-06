import { z } from "zod";
import { ThreadsEntrySchema } from "../../api-client";
import type { SentryApiService, ThreadEntrySchema } from "../../api-client";
import type { Event } from "../../api-client/types";
import {
  mapStructuredThread,
  mapStructuredThreadSummary,
  nonEmptyString,
  structuredThreadSchema,
  structuredThreadSummarySchema,
} from "./structured-stacktrace";

type Thread = z.infer<typeof ThreadEntrySchema>;
type ThreadSelector = string | number | undefined;

type SelectedThread =
  | {
      kind: "selected";
      thread: Thread;
    }
  | {
      kind: "not_found" | "ambiguous";
      message: string;
    };

const SELECTOR_HINT =
  "Pass `thread` as a numeric thread id or exact thread name.";

export const eventStacktraceOutputSchema = z.object({
  organizationSlug: z.string(),
  issueId: z.string(),
  eventId: z.string(),
  platform: z
    .string()
    .nullable()
    .describe("The event platform, which sets how to read frames."),
  threadCount: z.number(),
  selection: z.object({
    status: z
      .enum(["selected", "not_found", "ambiguous", "no_threads"])
      .describe(
        "`selected` returns `thread`. Otherwise `thread` is null and `message` says why.",
      ),
    message: z
      .string()
      .nullable()
      .describe("Why no thread was selected; null when one was."),
  }),
  thread: structuredThreadSchema
    .nullable()
    .describe("The selected thread and its stacktrace."),
  availableThreads: z
    .array(structuredThreadSummarySchema)
    .nullable()
    .describe(
      "Every thread on the event, listed only when the `thread` selector matched none or several.",
    ),
});

export type EventStacktracePayload = z.output<
  typeof eventStacktraceOutputSchema
>;

/**
 * Fetches an issue event and maps the selected thread stacktrace.
 */
export async function fetchEventStacktrace({
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
}): Promise<EventStacktracePayload> {
  const event = await apiService.getEventForIssue({
    organizationSlug,
    issueId,
    eventId,
  });

  const threads = getThreads(event);
  const base = {
    organizationSlug,
    issueId,
    eventId: event.id,
    platform: nonEmptyString(event.platform),
    threadCount: threads.length,
  };

  if (threads.length === 0) {
    return {
      ...base,
      selection: {
        status: "no_threads",
        message: "No thread stacktraces were found for this event.",
      },
      thread: null,
      availableThreads: null,
    };
  }

  const selected = selectThread(threads, thread);

  if (selected.kind !== "selected") {
    return {
      ...base,
      selection: {
        status: selected.kind,
        message: `${selected.message} ${SELECTOR_HINT}`,
      },
      thread: null,
      availableThreads: threads.map(mapStructuredThreadSummary),
    };
  }

  return {
    ...base,
    selection: { status: "selected", message: null },
    thread: mapStructuredThread(selected.thread),
    availableThreads: null,
  };
}

function getThreads(event: Event): Thread[] {
  const threadsEntry = event.entries?.find((entry) => entry.type === "threads");
  const result = ThreadsEntrySchema.safeParse(threadsEntry?.data);
  return result.success ? (result.data.values ?? []) : [];
}

function selectThread(
  threads: Thread[],
  selector: ThreadSelector,
): SelectedThread {
  if (selector === undefined) {
    const selected = selectSentryDefaultThread(threads);
    return { kind: "selected", thread: selected };
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
    sortedThreads[0]!
  );
}

function hasFrames(thread: Thread): boolean {
  return Boolean(thread.stacktrace?.frames?.length);
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

  return { kind: "selected", thread: matches[0]! };
}
