import {
  parse,
  type SeriesSyntax,
  SyntaxError as SeriesSyntaxError,
} from "../../generated/series-expression-grammar.js";
import {
  formatSeriesExpression,
  seriesTargets,
  TRANSFORMATION_DATASETS,
  TRANSFORMATION_DISPLAYS,
} from "../../lib/dashboard-series.js";
import { ValidationError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { type DashboardWidget, parseAggregate } from "../../types/dashboard.js";

const log = logger.withTag("dashboard");

/** Transformations by zero-based aggregate position, as Sentry stores them. */
type TransformationMap = Record<string, string[]>;

/** The flag a series came from, for error messages. */
type SeriesFlag = "query" | "transform";

/**
 * Parse one `--query` or `--transform` value: an aggregate, maybe wrapped
 * in `fill(…)` and `smooth(…)` calls (see grammar/series-expression.pegjs).
 *
 * @throws {ValidationError} With the position of the first error
 */
export function parseSeriesExpression(
  input: string,
  flag: SeriesFlag,
): SeriesSyntax {
  try {
    return parse(input);
  } catch (error) {
    if (!(error instanceof SeriesSyntaxError)) {
      throw error;
    }
    const column = error.location.start.column;
    throw new ValidationError(
      `Invalid --${flag} "${input}": ${error.message}\n\n` +
        `  ${input}\n  ${" ".repeat(column - 1)}^\n\n` +
        "Wrap an aggregate in transformations, innermost first: " +
        "fill(<series>, zero|linear|locf), smooth(<series>, sma, N), " +
        "smooth(<series>, ema, N[, A]), or smooth(<series>, asap[, N]). " +
        "N is a positive window size; A is greater than 0 and at most 1.",
      flag,
    );
  }
}

/**
 * Parse `--query` values into the aggregates the widget builders take and
 * the transformations written around them.
 *
 * @returns `undefined` when `--query` was not given
 */
export function parseQuerySeries(
  query: readonly string[] | undefined,
): SeriesSyntax[] | undefined {
  return query?.map((value) => {
    const series = parseSeriesExpression(value, "query");
    if (series.occurrence !== undefined) {
      throw new ValidationError(
        `--query "${value}": #${series.occurrence} picks one of several equal series for --transform. ` +
          "--query lists every series in order, so leave it out.",
        "query",
      );
    }
    return series;
  });
}

/** Positions of each aggregate, in order. */
function positionsByAggregate(
  aggregates: readonly string[],
): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  aggregates.forEach((aggregate, index) => {
    positions.set(aggregate, [...(positions.get(aggregate) ?? []), index]);
  });
  return positions;
}

/** The map without empty lists, which mean the same as no entry. */
function withoutEmpty(map: Readonly<TransformationMap>): TransformationMap {
  return Object.fromEntries(
    Object.entries(map).filter(([, steps]) => steps.length > 0),
  );
}

function sameTransformations(
  a: Readonly<TransformationMap>,
  b: Readonly<TransformationMap>,
): boolean {
  const left = withoutEmpty(a);
  const right = withoutEmpty(b);
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([key, steps]) =>
        right[key]?.length === steps.length &&
        steps.every((step, index) => right[key]?.[index] === step),
    )
  );
}

/**
 * Transformations of the new aggregate list. A series written with
 * transformations gets exactly those. A bare one keeps what the same
 * series had: the n-th `count()` inherits from the n-th saved `count()`,
 * wherever either sits in its list. Saved series that are gone take their
 * transformations with them, which is logged.
 */
function rebaseTransformations(
  series: readonly SeriesSyntax[],
  aggregates: readonly string[],
  savedAggregates: readonly string[],
  saved: Readonly<TransformationMap>,
): TransformationMap {
  const savedPositions = positionsByAggregate(savedAggregates);
  const seen = new Map<string, number>();
  const matched = new Set<number>();
  const map: TransformationMap = {};
  series.forEach((entry, index) => {
    const aggregate = aggregates[index] ?? "";
    const occurrence = seen.get(aggregate) ?? 0;
    seen.set(aggregate, occurrence + 1);
    const from = savedPositions.get(aggregate)?.[occurrence];
    if (from !== undefined) {
      matched.add(from);
    }
    const steps =
      entry.transformations.length > 0
        ? entry.transformations
        : from === undefined
          ? []
          : (saved[String(from)] ?? []);
    if (steps.length > 0) {
      map[String(index)] = [...steps];
    }
  });
  for (const [key, steps] of Object.entries(saved)) {
    const position = Number(key);
    if (steps.length > 0 && !matched.has(position)) {
      const aggregate = savedAggregates[position];
      log.warn(
        aggregate === undefined
          ? `Dropped transformations ${steps.join(" → ")} saved for aggregate ${position + 1}, which the widget no longer has.`
          : `Removed ${formatSeriesExpression(aggregate, steps)}: --query no longer lists ${aggregate} (aggregate ${position + 1}).`,
      );
    }
  }
  return map;
}

/**
 * Where a `--transform` value points in the aggregate list: the only series
 * with its aggregate, or the `#n`-th of several.
 */
function resolveTransformTarget(
  input: string,
  target: SeriesSyntax,
  aggregates: readonly string[],
  map: Readonly<TransformationMap>,
): number {
  const aggregate = parseAggregate(target.aggregate);
  const positions = positionsByAggregate(aggregates).get(aggregate) ?? [];
  if (positions.length === 0) {
    const listed =
      aggregates.length > 0 ? aggregates.join(", ") : "no aggregates";
    throw new ValidationError(
      `--transform "${input}": the widget has no ${aggregate} series. Its first query has ${listed}.`,
      "transform",
    );
  }
  if (target.occurrence !== undefined) {
    const position = positions[target.occurrence - 1];
    if (position === undefined) {
      throw new ValidationError(
        `--transform "${input}": the widget has ${positions.length} ${aggregate} series, so #${target.occurrence} names none of them.`,
        "transform",
      );
    }
    return position;
  }
  if (positions.length > 1) {
    const choices = positions.map((position, index) => {
      const current = formatSeriesExpression(
        aggregate,
        map[String(position)] ?? [],
      );
      return `  ${formatSeriesExpression(`${target.aggregate}#${index + 1}`, target.transformations)}  (aggregate ${position + 1}, now ${current})`;
    });
    throw new ValidationError(
      `--transform "${input}": the widget has ${positions.length} ${aggregate} series. ` +
        `Add #<n> to pick one:\n${choices.join("\n")}`,
      "transform",
    );
  }
  return positions[0] as number;
}

function hasSteps(map: Readonly<TransformationMap> | undefined): boolean {
  return Object.values(map ?? {}).some((steps) => steps.length > 0);
}

/** What the widget commands read to set transformations. */
export type SeriesTransformationInput = {
  /** Parsed `--query` values; `undefined` when not given. */
  readonly series?: readonly SeriesSyntax[];
  /** `--transform` values (edit only). */
  readonly transform?: readonly string[];
  /** Whether `--dataset` or `--display` was given. */
  readonly retyped?: boolean;
};

/**
 * Set the transformations of the widget's first query from `--query` and
 * `--transform`, keeping each saved series' transformations attached to it
 * when `--query` reorders or changes the aggregates.
 *
 * Sends the map only when it changed: Sentry keeps the saved one for a query
 * whose ID is sent without it.
 *
 * @param widget - Widget built from the flags, with the new aggregates
 * @param original - The widget as saved, when editing
 */
export function applySeriesTransformations(
  widget: DashboardWidget,
  input: SeriesTransformationInput,
  original?: DashboardWidget,
): DashboardWidget {
  const query = widget.queries?.[0];
  const aggregates = query?.aggregates ?? [];
  const savedQuery = original?.queries?.[0];
  const saved = savedQuery?.transformations ?? {};

  let map: TransformationMap = input.series
    ? rebaseTransformations(
        input.series,
        aggregates,
        savedQuery?.aggregates ?? [],
        saved,
      )
    : { ...saved };

  const inline = new Set(
    (input.series ?? []).flatMap((entry, index) =>
      entry.transformations.length > 0 ? [index] : [],
    ),
  );
  const transformed = new Map<number, string>();
  for (const value of input.transform ?? []) {
    const target = parseSeriesExpression(value, "transform");
    const position = resolveTransformTarget(value, target, aggregates, map);
    const earlier = transformed.get(position);
    if (earlier !== undefined || inline.has(position)) {
      throw new ValidationError(
        `--transform "${value}" sets aggregate ${position + 1}, which ${earlier === undefined ? "--query already transforms" : `--transform "${earlier}" already sets`}. ` +
          "Give each series' transformations once.",
        "transform",
      );
    }
    transformed.set(position, value);
    map = { ...map, [String(position)]: [...target.transformations] };
  }
  map = withoutEmpty(map);

  const changed = !sameTransformations(map, saved);
  if (changed || input.retyped) {
    const transformedElsewhere = (original?.queries ?? [])
      .slice(1)
      .some((remaining) => hasSteps(remaining.transformations));
    if (
      (hasSteps(map) || transformedElsewhere) &&
      !(
        TRANSFORMATION_DATASETS.includes(widget.widgetType ?? "") &&
        TRANSFORMATION_DISPLAYS.includes(widget.displayType ?? "")
      )
    ) {
      const targets = seriesTargets(aggregates);
      const clear = Object.keys(map)
        .map((key) => `--transform '${targets[Number(key)] ?? key}'`)
        .join(" ");
      throw new ValidationError(
        `Transformations need dataset ${TRANSFORMATION_DATASETS.join(", ")} and display ${TRANSFORMATION_DISPLAYS.join(", ")}. ` +
          "Choose a supported combination, or clear the transformations first" +
          (clear ? `: ${clear}` : "") +
          "." +
          (transformedElsewhere
            ? " The widget's other queries have transformations too, which these flags cannot change: they edit only the first query."
            : ""),
        "transform",
      );
    }
  }

  if (!(changed && query)) {
    return widget;
  }
  return {
    ...widget,
    queries: [
      { ...query, transformations: map },
      ...(widget.queries?.slice(1) ?? []),
    ],
  };
}

export const WIDGET_SERIES_HELP =
  "Transformations wrap a --query aggregate and run innermost first:\n" +
  "  fill(count, zero)                       fill gaps with zero, linear, or locf\n" +
  "  smooth(count, ema, 7)                   sma,N · ema,N[,A] · asap[,N]\n" +
  "  smooth(fill(p95:span.duration, linear), ema, 7)\n" +
  "Each series takes at most one fill and one smooth. Transformations need the\n" +
  "spans, logs, or tracemetrics dataset with a line, area, or bar display.";
