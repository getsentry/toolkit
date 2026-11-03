/**
 * Building blocks for command output schemas.
 *
 * A command declares its JSON output once, as a valibot schema in
 * `src/output-schemas/` (build-only: the command's `OutputConfig.schema` is
 * the field data generated from it), and derives the TypeScript type its `func`
 * yields and its `human` formatter takes from that schema, so the
 * compiler keeps the two in sync. Fields that come from the API keep the
 * `@sentry/api` SDK type; fields the CLI adds are written once as a valibot
 * `object` and joined on with {@link WithOutputFields}.
 */

import {
  boolean,
  custom,
  description,
  type GenericSchema,
  type InferOutput,
  optional,
  pipe,
} from "valibot";

/**
 * An API object with the fields a command adds to (or overrides on) it.
 *
 * `TFields` is the valibot schema of those fields; the schema the command
 * declares spreads its entries over the API schema's, so the fields win
 * there as they do here.
 */
export type WithOutputFields<TApi, TFields extends GenericSchema> = {
  // Not `Omit`: it drops the named keys of a type with an index signature
  // (the output of a `looseObject`).
  [
    K in keyof TApi as K extends keyof InferOutput<TFields> ? never : K
  ]: TApi[K];
} & InferOutput<TFields>;

/** The `dryRun: true` marker of a mutation's `--dry-run` JSON output. */
export const DryRunOutputField = optional(
  pipe(boolean(), description("True when --dry-run made no change")),
);

/**
 * A field the docs leave opaque (`unknown`, no nested `--fields` paths)
 * whose TypeScript type the CLI knows, such as a full event payload.
 * Nothing validates output, so it accepts any value.
 */
export function opaque<T>() {
  return custom<T>(() => true);
}
