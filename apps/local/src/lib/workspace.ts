import { eventKind, feedbackData, isAiPayload, text } from "./inspection.ts";
import type { EventMetadata, LocalFeedItem } from "./spotlight.ts";

function getMetadata(item: LocalFeedItem): EventMetadata {
  return item.metadata ?? { title: item.type };
}

export const workspaceViews = [
  "live",
  "traces",
  "errors",
  "logs",
  "ai",
  "envelopes",
  "sdks",
  "feedback",
  "profiles",
  "queries",
  "resources",
  "web-vitals",
  "attachments",
] as const;

export type WorkspaceView = (typeof workspaceViews)[number];

export function workspacePath(view: WorkspaceView) {
  return view === "live" ? "/live" : `/${view}`;
}

export function workspaceFromPath(pathname: string): WorkspaceView {
  if (pathname === "/") {
    return "live";
  }

  const view = pathname.slice(1);
  return workspaceViews.includes(view as WorkspaceView)
    ? (view as WorkspaceView)
    : "live";
}

export function isErrorEvent(item: LocalFeedItem) {
  const { level, statusCode } = getMetadata(item);
  return (
    level === "error" ||
    level === "fatal" ||
    (statusCode !== undefined && statusCode >= 500)
  );
}

export function isAiEvent(item: LocalFeedItem) {
  const metadata = getMetadata(item);
  return (
    isAiPayload(item.payload) ||
    [item.type, metadata.operation, metadata.origin].some(
      (value) =>
        value !== undefined &&
        /(?:^|[.\s:_-])(?:ai|gen_ai|llm)(?:$|[.\s:_-])/i.test(value),
    )
  );
}

/** Session updates, server `sessions` aggregates and client reports. */
export const SDK_REPORT_TYPES = new Set([
  "session",
  "sessions",
  "client_report",
]);

export function workspaceForItem(item: LocalFeedItem): WorkspaceView {
  if (item.type === "envelope") {
    return "envelopes";
  }
  if (isAiEvent(item)) {
    return "ai";
  }
  if (isErrorEvent(item)) {
    return "errors";
  }
  if (item.type === "transaction" || item.type === "span") {
    return "traces";
  }
  if (item.type === "log") {
    return "logs";
  }
  if (item.type === "user_report" || item.type === "feedback") {
    return "feedback";
  }
  if (item.type === "attachment") return "attachments";
  if (item.type === "profile" || item.type === "profile_chunk") {
    return "profiles";
  }
  if (SDK_REPORT_TYPES.has(item.type)) {
    return "sdks";
  }
  return "live";
}

/**
 * Badge and title for an event list entry. Request transactions and spans
 * read best as method and route. A custom transaction (op `task`, …) started
 * inside a request also carries that request, but is labelled by its own
 * operation and name.
 */
export function eventListLabel(item: LocalFeedItem): {
  badge: string;
  title: string;
} {
  const metadata = getMetadata(item);
  if (item.type === "event")
    return { badge: eventKind(item.payload), title: metadata.title };
  const { operation } = metadata;
  if (
    item.type === "transaction" &&
    operation &&
    !/^http\.server(?:\.|$)/.test(operation)
  )
    return { badge: operation, title: metadata.title };
  return {
    badge:
      metadata.method ??
      (item.type === "transaction"
        ? "Request"
        : item.type === "log"
          ? "Log"
          : (operation ?? item.type)),
    title:
      item.type === "feedback" || item.type === "user_report"
        ? (feedbackMessage(item.payload) ?? metadata.title)
        : (metadata.route ?? metadata.title),
  };
}

function feedbackMessage(payload: unknown): string | undefined {
  const feedback = feedbackData(payload);
  return text(feedback.message) ?? text(feedback.comments);
}

export function matchesSearch(item: LocalFeedItem, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const metadata = getMetadata(item);
  return [
    item.type,
    item.text,
    metadata.title,
    metadata.level,
    metadata.method,
    metadata.route,
    metadata.traceId,
    metadata.spanId,
    metadata.operation,
    metadata.origin,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}

export function eventSearchValue(item: LocalFeedItem) {
  const metadata = getMetadata(item);
  return [
    item.type,
    metadata.title,
    metadata.level,
    metadata.method,
    metadata.route,
    metadata.traceId,
    metadata.operation,
    metadata.origin,
  ]
    .filter(Boolean)
    .join(" ");
}
