/**
 * Explore datasets for `--dataset` flags: the user-facing names, their
 * aliases, and the API names they map to.
 */

import { ValidationError } from "./errors.js";

/** API-level dataset names */
export type ExploreDataset =
  | "errors"
  | "spans"
  | "logs"
  | "tracemetrics"
  | "replays";

/** Canonical user-facing name for each API dataset */
const DISPLAY_NAMES: Record<ExploreDataset, string> = {
  errors: "errors",
  spans: "spans",
  logs: "logs",
  tracemetrics: "metrics",
  replays: "replays",
};

/** Every accepted spelling (lowercase) → API dataset */
const ALIASES: Record<string, ExploreDataset> = {
  errors: "errors",
  error: "errors",
  spans: "spans",
  span: "spans",
  logs: "logs",
  log: "logs",
  metrics: "tracemetrics",
  metric: "tracemetrics",
  tracemetrics: "tracemetrics",
  replays: "replays",
  replay: "replays",
};

/**
 * User-facing name for an API dataset, e.g. `tracemetrics` to `metrics`.
 */
export function datasetDisplayName(dataset: string): string {
  return DISPLAY_NAMES[dataset as ExploreDataset] ?? dataset;
}

/**
 * Build a `--dataset` parser that accepts only `allowed` datasets, by their
 * user-facing names or aliases, and returns the API name.
 *
 * @param allowed - API datasets the command supports, in help order
 * @param passthrough - Extra lowercase values accepted and returned as-is
 *   (e.g. explore's legacy `transactions`)
 * @returns The parser and the user-facing names for help and errors
 */
export function buildDatasetParser<
  T extends ExploreDataset,
  P extends string = never,
>(
  allowed: readonly T[],
  passthrough: readonly P[] = [],
): { parse: (value: string) => T | P; names: readonly string[] } {
  const names = allowed.map(datasetDisplayName);
  const parse = (value: string): T | P => {
    const lower = value.trim().toLowerCase();
    const resolved = ALIASES[lower];
    if (resolved && (allowed as readonly ExploreDataset[]).includes(resolved)) {
      return resolved as T;
    }
    if ((passthrough as readonly string[]).includes(lower)) {
      return lower as P;
    }
    throw new ValidationError(
      `Invalid dataset "${value}". Must be one of: ${names.join(", ")}`,
      "dataset",
    );
  };
  return { parse, names };
}
