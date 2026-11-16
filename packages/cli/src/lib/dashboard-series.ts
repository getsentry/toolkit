/**
 * How dashboard widget series are written on the command line: an
 * aggregate inside the transformations Sentry applies to it, innermost
 * first (`smooth(fill(count(),linear),ema,7)`), with `#<n>` naming one of
 * several equal aggregates. `grammar/series-expression.pegjs` parses them;
 * these helpers write them back, for output and shell completion.
 *
 * This module is imported by the `__complete` fast path, so it must stay
 * free of other imports.
 */

/** Datasets whose widgets Sentry applies transformations to. */
export const TRANSFORMATION_DATASETS: readonly string[] = [
  "spans",
  "logs",
  "tracemetrics",
];

/** Displays whose widgets Sentry applies transformations to. */
export const TRANSFORMATION_DISPLAYS: readonly string[] = [
  "line",
  "area",
  "bar",
];

/**
 * Write a series, nesting its transformations around the aggregate in the
 * order Sentry applies them: `count()` with `["fill(linear)",
 * "smooth(ema,7)"]` is `smooth(fill(count(),linear),ema,7)`.
 */
export function formatSeriesExpression(
  aggregate: string,
  transformations: readonly string[],
): string {
  return transformations.reduce((inner, step) => {
    const open = step.indexOf("(");
    if (open === -1 || !step.endsWith(")")) {
      return `${step}(${inner})`;
    }
    // Sentry keeps the spacing a step was saved with (`smooth( ema , 7 )`)
    const args = step
      .slice(open + 1, -1)
      .split(",")
      .map((arg) => arg.trim())
      .filter(Boolean);
    return `${step.slice(0, open).trim()}(${[inner, ...args].join(",")})`;
  }, aggregate);
}

/**
 * How `--transform` names each aggregate: the aggregate itself, or with
 * `#<n>` when the list has it more than once (`count()#2`).
 */
export function seriesTargets(aggregates: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const aggregate of aggregates) {
    counts.set(aggregate, (counts.get(aggregate) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return aggregates.map((aggregate) => {
    const occurrence = (seen.get(aggregate) ?? 0) + 1;
    seen.set(aggregate, occurrence);
    return (counts.get(aggregate) ?? 0) > 1
      ? `${aggregate}#${occurrence}`
      : aggregate;
  });
}
