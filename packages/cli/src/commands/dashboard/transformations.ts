import {
  array,
  check,
  digits,
  gtValue,
  literal,
  maxValue,
  minValue,
  object,
  optional,
  picklist,
  pipe,
  record,
  regex,
  safeInteger,
  safeParse,
  strictTuple,
  string,
  toNumber,
  union,
  variant,
} from "valibot";
import { textParser } from "../../lib/completion-target.js";
import { ValidationError } from "../../lib/errors.js";
import type { DashboardWidget } from "../../types/dashboard.js";
import type { WidgetQueryFlags } from "./resolve.js";

/** Ordered transformation replacements by zero-based aggregate position. */
export type WidgetTransformationFlags = {
  readonly transformations?: string | Record<string, string[]>;
};

const transformationsSchema = record(string(), array(string()));
const integerStringSchema = pipe(
  string(),
  digits(),
  check((value) => value === "0" || !value.startsWith("0")),
  toNumber(),
  safeInteger(),
);
const axisIndexSchema = pipe(integerStringSchema, minValue(0));
const windowSchema = pipe(integerStringSchema, minValue(1));
const alphaSchema = pipe(
  string(),
  regex(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i),
  toNumber(),
  gtValue(0),
  maxValue(1),
);
const transformationSchema = variant("name", [
  object({
    name: literal("fill"),
    arguments: strictTuple([picklist(["zero", "linear", "locf"])]),
  }),
  object({
    name: literal("smooth"),
    arguments: union([
      strictTuple([literal("sma"), windowSchema]),
      strictTuple([literal("ema"), windowSchema, optional(alphaSchema)]),
      strictTuple([literal("asap"), optional(windowSchema)]),
    ]),
  }),
]);

function invalidTransformations(message: string): never {
  throw new ValidationError(message, "transformations");
}

function validateTransformation(expression: string): string {
  const match = /^(\w+)\(([^()\r\n]*)\)$/.exec(expression);
  const parsed = safeParse(transformationSchema, {
    name: match?.[0] === expression ? match[1] : undefined,
    arguments: match?.[2]?.split(",").map((arg) => arg.trim()) ?? [],
  });
  if (parsed.success) {
    return parsed.output.name;
  }
  return invalidTransformations(
    `Invalid transformation "${expression}". Use fill(zero|linear|locf), smooth(sma,N), smooth(ema,N[,A]), or smooth(asap[,N]). N must be a positive integer and A must be greater than 0 and at most 1.`,
  );
}

/** Parse a JSON axis patch. Empty arrays clear axes and omitted axes preserve them. */
export function parseTransformations(value: string): Record<string, string[]> {
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return invalidTransformations(
      `Expected a JSON object, for example '{"0":["fill(linear)"],"1":[]}'. ${detail}`,
    );
  }
  if (typeof input === "object" && input !== null) {
    for (const index of Object.keys(input)) {
      if (!safeParse(axisIndexSchema, index).success) {
        invalidTransformations(
          `Invalid aggregate position "${index}". Use a zero-based integer such as "0" or "1".`,
        );
      }
    }
  }
  const parsed = safeParse(transformationsSchema, input);
  if (!parsed.success) {
    return invalidTransformations(
      'Expected a JSON object mapping aggregate positions to arrays of transformation strings, for example \'{"0":["fill(linear)"],"1":[]}\'.',
    );
  }
  for (const [index, axisTransformations] of Object.entries(parsed.output)) {
    const kinds = axisTransformations.map(validateTransformation);
    if (
      axisTransformations.length > 2 ||
      new Set(kinds).size !== axisTransformations.length
    ) {
      invalidTransformations(
        `Aggregate position ${index} accepts at most one fill and one smooth transformation, in either order.`,
      );
    }
  }
  return parsed.output;
}

export const WIDGET_TRANSFORMATION_FLAGS = {
  transformations: {
    kind: "parsed",
    parse: textParser(parseTransformations),
    brief:
      'JSON axis patch, e.g. \'{"0":["fill(linear)","smooth(ema,7)"],"1":[]}\'. Omitted axes preserve saved transformations; [] clears an axis',
    optional: true,
  },
} as const;

export const WIDGET_TRANSFORMATION_HELP =
  "Transformations (--transformations) target zero-based aggregate positions in the first query.\n" +
  "Pass a JSON object mapping positions to arrays of ordered transformations.\n" +
  "Each array replaces that axis's transformations.\n" +
  "Omitted axes preserve saved values; [] clears an axis; {} changes nothing.\n" +
  "Supported datasets are spans, logs, and tracemetrics with line, area, or bar displays.\n" +
  "When changing --query, explicitly set or clear every saved transformed position.\n" +
  "A removed position can be acknowledged with [].";

/** Merge explicit axis edits while keeping untouched saved queries on the omission path. */
export function updateWidgetTransformations(
  widget: DashboardWidget,
  flags: WidgetQueryFlags & WidgetTransformationFlags,
  original?: DashboardWidget,
): DashboardWidget {
  const patch =
    typeof flags.transformations === "string"
      ? parseTransformations(flags.transformations)
      : flags.transformations;
  const savedQuery = original?.queries?.[0];
  const query = widget.queries?.[0];
  const aggregates = query?.aggregates ?? [];
  const savedAggregates = savedQuery?.aggregates ?? [];
  const saved = savedQuery?.transformations ?? {};
  const aggregatesChanged =
    flags.query !== undefined &&
    (aggregates.length !== savedAggregates.length ||
      aggregates.some(
        (aggregate, index) => aggregate !== savedAggregates[index],
      ));

  if (aggregatesChanged) {
    for (const [index, axisTransformations] of Object.entries(saved)) {
      if (
        (axisTransformations.length > 0 ||
          Number(index) >= aggregates.length) &&
        !Object.hasOwn(patch ?? {}, index)
      ) {
        invalidTransformations(
          `Changing --query requires explicit transformations or [] for saved aggregate position ${index}. Pass --transformations to correct its association, including removed positions.`,
        );
      }
    }
  }

  const edited = patch !== undefined && Object.keys(patch).length > 0;
  let transformations = saved;
  if (edited) {
    transformations = Object.fromEntries(
      Object.entries(saved).filter(
        ([, axisTransformations]) => axisTransformations.length > 0,
      ),
    );
    for (const [index, axisTransformations] of Object.entries(patch)) {
      const axis = Number(index);
      if (
        axis >= aggregates.length &&
        !(axisTransformations.length === 0 && axis < savedAggregates.length)
      ) {
        invalidTransformations(
          `Aggregate position ${index} is out of range for ${aggregates.length} aggregate(s). Use a position from --query; [] may also clear a removed saved position.`,
        );
      }
      if (axisTransformations.length === 0) {
        delete transformations[index];
      } else {
        transformations[index] = axisTransformations;
      }
    }
  }

  if (edited || flags.dataset !== undefined || flags.display !== undefined) {
    const hasTransformations =
      Object.values(transformations).some(
        (axisTransformations) => axisTransformations.length > 0,
      ) ||
      (original?.queries
        ?.slice(1)
        .some((remaining) =>
          Object.values(remaining.transformations ?? {}).some(
            (axisTransformations) => axisTransformations.length > 0,
          ),
        ) ??
        false);
    if (
      hasTransformations &&
      !(
        ["spans", "logs", "tracemetrics"].includes(widget.widgetType ?? "") &&
        ["line", "area", "bar"].includes(widget.displayType ?? "")
      )
    ) {
      invalidTransformations(
        "Transformations require dataset spans, logs, or tracemetrics and display line, area, or bar. Choose a supported combination or clear the saved transformations before changing dataset or display. Transformation flags edit only the first query.",
      );
    }
  }

  if (!(edited && query)) {
    return widget;
  }
  return {
    ...widget,
    queries: [
      { ...query, transformations },
      ...(widget.queries?.slice(1) ?? []),
    ],
  };
}
