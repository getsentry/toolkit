import {
  boolean,
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
  regex,
  safeInteger,
  safeParse,
  string,
  toNumber,
  union,
} from "valibot";
import { textParser } from "../../lib/completion-target.js";
import { ValidationError } from "../../lib/errors.js";
import type { DashboardWidget } from "../../types/dashboard.js";
import type { WidgetQueryFlags } from "./resolve.js";

const FILL_MODES = ["zero", "linear", "locf", "none"] as const;
const SMOOTH_MODES = ["sma", "ema", "asap", "none"] as const;
const ORDERS = ["fill-first", "smooth-first"] as const;

export type WidgetTransformationFlags = {
  readonly "transform-aggregate"?: string;
  readonly "transform-fill"?: (typeof FILL_MODES)[number];
  readonly "transform-smooth"?: (typeof SMOOTH_MODES)[number];
  readonly "transform-window"?: string;
  readonly "transform-alpha"?: string;
  readonly "transform-order"?: (typeof ORDERS)[number];
  readonly "transform-clear"?: boolean;
};

type TransformationChange =
  | { kind: "keep" }
  | { kind: "remove" }
  | { kind: "set"; expression: string };

type TransformationEdit = {
  aggregate: number | "all" | undefined;
  fill: TransformationChange;
  smooth: TransformationChange;
  order: (typeof ORDERS)[number] | undefined;
};

const positiveIntegerSchema = pipe(
  string(),
  digits("Use a positive integer."),
  check(
    (value) => !value.startsWith("0"),
    "Use a positive integer without leading zeros.",
  ),
  toNumber(),
  safeInteger("Use a safe integer."),
  minValue(1, "Use a positive integer."),
);
const alphaSchema = pipe(
  string(),
  regex(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i, "Use a decimal EMA factor."),
  toNumber(),
  gtValue(0, "EMA alpha must be greater than 0 and at most 1."),
  maxValue(1, "EMA alpha must be greater than 0 and at most 1."),
);
const flagSchema = object({
  "transform-aggregate": optional(
    union([literal("all"), positiveIntegerSchema]),
  ),
  "transform-fill": optional(picklist(FILL_MODES)),
  "transform-smooth": optional(picklist(SMOOTH_MODES)),
  "transform-window": optional(positiveIntegerSchema),
  "transform-alpha": optional(alphaSchema),
  "transform-order": optional(picklist(ORDERS)),
  "transform-clear": optional(boolean()),
});

function invalidTransformations(message: string): never {
  throw new ValidationError(message, "transformations");
}

export function parseTransformationFlags(
  flags: unknown,
): TransformationEdit | undefined {
  const parsed = safeParse(flagSchema, flags);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    const key = issue.path?.[0]?.key;
    return invalidTransformations(
      `Invalid --${typeof key === "string" ? key : "transform"}. ${issue.message}`,
    );
  }
  const {
    "transform-aggregate": aggregate,
    "transform-fill": fill,
    "transform-smooth": smooth,
    "transform-window": window,
    "transform-alpha": alpha,
    "transform-order": order,
    "transform-clear": clear,
  } = parsed.output;
  const hasSettings =
    fill !== undefined ||
    smooth !== undefined ||
    window !== undefined ||
    alpha !== undefined ||
    order !== undefined;
  if (clear && hasSettings) {
    invalidTransformations(
      "--transform-clear cannot be combined with other transformation settings. Select an aggregate and clear it, or specify fill and smoothing settings.",
    );
  }
  if (!(clear || hasSettings)) {
    if (aggregate !== undefined) {
      invalidTransformations(
        "--transform-aggregate requires a transformation setting or --transform-clear.",
      );
    }
    return undefined;
  }
  if (window !== undefined && (smooth === undefined || smooth === "none")) {
    invalidTransformations(
      "--transform-window requires --transform-smooth sma, ema, or asap.",
    );
  }
  if (alpha !== undefined && smooth !== "ema") {
    invalidTransformations(
      "--transform-alpha requires --transform-smooth ema.",
    );
  }
  if ((smooth === "sma" || smooth === "ema") && window === undefined) {
    invalidTransformations(
      `--transform-smooth ${smooth} requires --transform-window with a positive integer.`,
    );
  }
  let smoothChange: TransformationChange = { kind: "keep" };
  if (clear || smooth === "none") {
    smoothChange = { kind: "remove" };
  } else if (smooth !== undefined) {
    const args = [smooth, window, alpha].filter((arg) => arg !== undefined);
    smoothChange = { kind: "set", expression: `smooth(${args.join(",")})` };
  }
  return {
    aggregate,
    fill:
      clear || fill === "none"
        ? { kind: "remove" }
        : fill === undefined
          ? { kind: "keep" }
          : { kind: "set", expression: `fill(${fill})` },
    smooth: smoothChange,
    order,
  };
}

export const WIDGET_TRANSFORMATION_FLAGS = {
  "transform-aggregate": {
    kind: "parsed",
    parse: textParser(String),
    optional: true,
    brief:
      "Aggregate number (1-based) or all; optional for a single aggregate. Edits the first query",
  },
  "transform-fill": {
    kind: "enum",
    values: FILL_MODES,
    optional: true,
    brief:
      "Fill gaps with zero, linear, or locf; none removes filling. Omission preserves saved filling",
  },
  "transform-smooth": {
    kind: "enum",
    values: SMOOTH_MODES,
    optional: true,
    brief:
      "Replace the complete smoothing configuration; none removes smoothing. Omission preserves saved smoothing",
  },
  "transform-window": {
    kind: "parsed",
    parse: textParser(String),
    optional: true,
    brief:
      "Positive integer window for sma/ema (required), or maximum window for asap (optional)",
  },
  "transform-alpha": {
    kind: "parsed",
    parse: textParser(String),
    optional: true,
    brief:
      "EMA factor greater than 0 and at most 1; requires explicit --transform-smooth ema. Omission uses automatic alpha",
  },
  "transform-order": {
    kind: "enum",
    values: ORDERS,
    optional: true,
    brief:
      "Application order; requires both fill and smooth. Existing pairs preserve order; new pairs default to fill-first",
  },
  "transform-clear": {
    kind: "boolean",
    optional: true,
    brief:
      "Clear both transformations on the selected aggregate(s); conflicts with other transformation settings",
  },
} as const;

export const WIDGET_TRANSFORMATION_HELP =
  "Transformation flags edit the first query. --transform-aggregate selects a 1-based aggregate number or all.\n" +
  "With multiple aggregates, select one explicitly. The selector applies to the whole command.\n" +
  "Omitted fill or smooth settings preserve that kind's full saved configuration. Use none to remove a kind.\n" +
  "A supplied --transform-smooth replaces its complete configuration; ema without --transform-alpha uses automatic alpha.\n" +
  "sma and ema require --transform-window. asap uses an automatic window unless a maximum is supplied.\n" +
  "Flag order does not affect transformation order. Existing pairs preserve order; new pairs default to fill-first.\n" +
  "Use --transform-order to override order, or --transform-clear to remove both kinds.\n" +
  "Supported datasets are spans, logs, and tracemetrics with line, area, or bar displays.\n" +
  "When changing --query, explicitly set both fill and smooth (including none), or clear every saved transformed position.\n" +
  "--transform-aggregate all also clears removed positions. Different settings on several aggregates require separate commands.";

function editTransformations(
  saved: string[],
  edit: TransformationEdit,
): string[] {
  const changes = { fill: edit.fill, smooth: edit.smooth };
  const result: string[] = [];
  const seen = new Set<string>();
  for (const expression of saved) {
    const kind = expression.slice(0, expression.indexOf("(")).trim();
    if (kind !== "fill" && kind !== "smooth") {
      if (edit.fill.kind === "remove" && edit.smooth.kind === "remove") {
        continue;
      }
      invalidTransformations(
        "The selected aggregate has an unrecognized saved transformation. Clear it with --transform-clear before configuring transformations.",
      );
    }
    seen.add(kind);
    const change = changes[kind];
    if (change.kind === "keep") result.push(expression);
    else if (change.kind === "set") result.push(change.expression);
  }
  for (const kind of ["fill", "smooth"] as const) {
    const change = changes[kind];
    if (!seen.has(kind) && change.kind === "set")
      result.push(change.expression);
  }
  const order =
    edit.order ??
    (seen.has("fill") && seen.has("smooth") ? undefined : "fill-first");
  const fillIndex = result.findIndex((expression) =>
    expression.startsWith("fill("),
  );
  const smoothIndex = result.findIndex((expression) =>
    expression.startsWith("smooth("),
  );
  if (edit.order && (fillIndex < 0 || smoothIndex < 0)) {
    invalidTransformations(
      "--transform-order requires both fill and smooth to remain active on every selected aggregate.",
    );
  }
  if (
    fillIndex >= 0 &&
    smoothIndex >= 0 &&
    ((order === "fill-first" && fillIndex > smoothIndex) ||
      (order === "smooth-first" && smoothIndex > fillIndex))
  ) {
    result.reverse();
  }
  return result;
}

export function updateWidgetTransformations(
  widget: DashboardWidget,
  flags: WidgetQueryFlags & WidgetTransformationFlags,
  original?: DashboardWidget,
): DashboardWidget {
  const edit = parseTransformationFlags(flags);
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
  const selected = new Set<number>();
  if (edit) {
    if (edit.aggregate === "all") {
      for (let index = 0; index < aggregates.length; index++)
        selected.add(index);
      for (const index of Object.keys(saved)) selected.add(Number(index));
    } else {
      if (edit.aggregate === undefined && aggregates.length !== 1) {
        invalidTransformations(
          `Choose --transform-aggregate <number> or all. Aggregates in the first query:\n${aggregates.map((aggregate, index) => `  ${index + 1}. ${aggregate}`).join("\n")}`,
        );
      }
      const index = (edit.aggregate ?? 1) - 1;
      const clearing =
        edit.fill.kind === "remove" && edit.smooth.kind === "remove";
      if (
        index >= aggregates.length &&
        !(clearing && index < savedAggregates.length)
      ) {
        invalidTransformations(
          `Aggregate ${index + 1} is out of range for ${aggregates.length} aggregate(s). A removed saved aggregate can only be cleared.`,
        );
      }
      selected.add(index);
    }
  }
  if (aggregatesChanged) {
    for (const [index, transformations] of Object.entries(saved)) {
      if (
        (transformations.length > 0 || Number(index) >= aggregates.length) &&
        !(
          selected.has(Number(index)) &&
          edit &&
          edit.fill.kind !== "keep" &&
          edit.smooth.kind !== "keep"
        )
      ) {
        invalidTransformations(
          `Changing --query requires explicit --transform-fill and --transform-smooth (use none to remove a kind), or --transform-clear, for saved aggregate ${Number(index) + 1}. Use --transform-aggregate all to acknowledge every saved position, including removed positions.`,
        );
      }
    }
  }
  let transformations = saved;
  if (edit) {
    // Sentry replaces an explicit map in full, so merge untouched axes before saving.
    transformations = Object.fromEntries(
      Object.entries(saved).filter(([, values]) => values.length > 0),
    );
    for (const index of selected) {
      const values =
        index < aggregates.length
          ? editTransformations(saved[String(index)] ?? [], edit)
          : [];
      if (values.length > 0) transformations[String(index)] = values;
      else delete transformations[String(index)];
    }
  }
  if (edit || flags.dataset !== undefined || flags.display !== undefined) {
    const hasTransformations =
      Object.values(transformations).some((values) => values.length > 0) ||
      (original?.queries
        ?.slice(1)
        .some((remaining) =>
          Object.values(remaining.transformations ?? {}).some(
            (values) => values.length > 0,
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
  if (!(edit && query)) return widget;
  return {
    ...widget,
    queries: [
      { ...query, transformations },
      ...(widget.queries?.slice(1) ?? []),
    ],
  };
}
