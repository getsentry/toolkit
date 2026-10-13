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
    `${item.type} ${metadata.operation ?? ""} ${metadata.origin ?? ""}`
      .toLowerCase()
      .match(/ai|gen_ai|llm/) !== null
  );
}

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
  if (item.type === "profile" || item.type === "profile_chunk") {
    return "profiles";
  }
  if (item.type === "client_report" || item.type === "session") {
    return "sdks";
  }
  return "live";
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
