import { z } from "zod";
import { ApiClientError } from "../../../api-client";
import type { CustomInboundFilter } from "../../../api-client";
import { UserInputError } from "../../../errors";

/**
 * Shared schema, validation and formatting for the custom inbound filter tools.
 *
 * Mirrors src/sentry/api/endpoints/project_custom_inbound_filters.py and
 * src/sentry/ingest/inbound_filters.py in the Sentry monolith.
 */

export const CUSTOM_INBOUND_FILTER_DATA_TYPES = [
  "all",
  "error",
  "log",
  "metric",
  "span",
] as const;

export const CUSTOM_INBOUND_FILTER_CONDITION_TYPES = [
  "error_type",
  "error_message",
  "log_message",
  "metric_name",
  "release",
  "ip_address",
] as const;

export type CustomInboundFilterDataType =
  (typeof CUSTOM_INBOUND_FILTER_DATA_TYPES)[number];
export type CustomInboundFilterConditionType =
  (typeof CUSTOM_INBOUND_FILTER_CONDITION_TYPES)[number];

export const MAX_CONDITIONS_PER_FILTER = 10;
export const MAX_FILTERS_PER_PROJECT = 50;

/** Condition types every data type accepts, plus the ones only some carry a field for. */
const CONDITION_TYPES_BY_DATA_TYPE: Record<
  CustomInboundFilterDataType,
  readonly CustomInboundFilterConditionType[]
> = {
  all: ["release", "ip_address"],
  error: ["error_type", "error_message", "release", "ip_address"],
  log: ["log_message", "release", "ip_address"],
  metric: ["metric_name", "release", "ip_address"],
  span: ["release", "ip_address"],
};

export const ParamCustomInboundFilterDataType = z
  .enum(CUSTOM_INBOUND_FILTER_DATA_TYPES)
  .describe(
    "The data the filter drops: `error` (errors and messages), `log`, `metric`, `span`, or `all`. `all` matches every data type Sentry ingests, including ones added later, and accepts only `release` and `ip_address` conditions.",
  );

export const ParamCustomInboundFilterConditions = z
  .array(
    z.object({
      type: z
        .enum(CUSTOM_INBOUND_FILTER_CONDITION_TYPES)
        .describe(
          "The field to match. Every data type accepts `release` and `ip_address`. `error` also accepts `error_type` and `error_message`, `log` accepts `log_message`, `metric` accepts `metric_name`.",
        ),
      value: z
        .array(z.string().trim().min(1))
        .min(1)
        .describe(
          "Patterns for the field. The condition matches when ANY pattern matches (OR). Patterns are case-insensitive globs where `*` matches any characters and `?` one character, e.g. `*ConnectionError*`, `my-app@2.1.*`, `checkout.*`. For `ip_address`, each value must be an IP address or CIDR range such as `203.0.113.7` or `10.0.0.0/8`.",
        ),
    }),
  )
  .min(1)
  .max(MAX_CONDITIONS_PER_FILTER)
  .describe(
    `Conditions are combined with AND: data is dropped only when every condition matches. Use several values inside one condition for OR, or create separate filters. At most ${MAX_CONDITIONS_PER_FILTER} conditions per filter.`,
  );

export const ParamCustomInboundFilterId = z
  .string()
  .trim()
  .min(1)
  .describe(
    "The custom inbound filter ID. Use find_custom_inbound_filters() to look it up.",
  );

export const customInboundFilterItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  active: z.boolean(),
  dataType: z.string(),
  conditions: z.array(
    z.object({
      type: z.string(),
      value: z.array(z.string()),
    }),
  ),
  dateCreated: z.string().nullable(),
  dateUpdated: z.string().nullable(),
});

export type CustomInboundFilterItem = z.infer<
  typeof customInboundFilterItemSchema
>;

export function toCustomInboundFilterItem(
  filter: CustomInboundFilter,
): CustomInboundFilterItem {
  return {
    id: String(filter.id),
    name: filter.name,
    active: filter.active,
    dataType: filter.dataType,
    conditions: filter.conditions.map((condition) => ({
      type: condition.type,
      value: [...condition.value],
    })),
    dateCreated: filter.dateCreated,
    dateUpdated: filter.dateUpdated,
  };
}

/**
 * Rejects a condition the data type has no field for before the request is sent,
 * so the agent gets the allowed list instead of a generic 400.
 */
export function assertConditionsMatchDataType(
  dataType: CustomInboundFilterDataType,
  conditions: Array<{ type: CustomInboundFilterConditionType }>,
): void {
  const allowed = CONDITION_TYPES_BY_DATA_TYPE[dataType];
  const unsupported = [
    ...new Set(
      conditions
        .map((condition) => condition.type)
        .filter((type) => !allowed.includes(type)),
    ),
  ];
  if (unsupported.length === 0) {
    return;
  }
  throw new UserInputError(
    `A filter on ${dataType} data cannot use the ${unsupported.join(", ")} condition. It accepts ${allowed.join(", ")}.`,
  );
}

/**
 * Sentry answers 400 "You do not have that feature enabled" when the organization
 * is not on custom inbound filters yet. Rewrite that into a message that names the
 * feature; pass every other API error through unchanged.
 */
export function rethrowCustomInboundFilterError(error: unknown): never {
  if (
    error instanceof ApiClientError &&
    error.status === 400 &&
    /feature enabled/i.test(error.message)
  ) {
    throw new UserInputError(
      "Custom inbound filters are not enabled for this organization. The built-in inbound filters in Project Settings > Inbound Filters still apply.",
      { cause: error },
    );
  }
  throw error;
}
