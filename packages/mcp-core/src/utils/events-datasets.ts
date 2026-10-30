export const PUBLIC_EVENTS_DATASETS = [
  "spans",
  "errors",
  "logs",
  "metrics",
  "profiles",
] as const;

export type PublicEventsDataset = (typeof PUBLIC_EVENTS_DATASETS)[number];

export const DROPPED_EVENTS_DATASETS = [
  "spans",
  "logs",
  "metrics",
  "errors",
] as const;

export type DroppedEventsDataset = (typeof DROPPED_EVENTS_DATASETS)[number];
export type EventsApiDataset =
  | "spans"
  | "errors"
  | "logs"
  | "tracemetrics"
  | "profiles";
export type EventsDataset = PublicEventsDataset | "tracemetrics";

export function isMetricsDataset(
  dataset: EventsDataset,
): dataset is "metrics" | "tracemetrics" {
  return dataset === "metrics" || dataset === "tracemetrics";
}

export function isProfilesDataset(
  dataset: EventsDataset,
): dataset is "profiles" {
  return dataset === "profiles";
}

/**
 * Sentry's product-facing Explore schemas already call this dataset "metrics",
 * but the current `/events/` and `/trace-items/attributes/` APIs still expect
 * the legacy `tracemetrics` identifier. Keep MCP aligned with the UI-facing
 * schema and swap only at the transport boundary until the upstream API name
 * catches up.
 */
export function normalizeEventsDataset(
  dataset: EventsDataset,
): EventsApiDataset {
  return dataset === "metrics" ? "tracemetrics" : dataset;
}
