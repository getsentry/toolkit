import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { ToolOutputSchema } from "../../tools/types";

type JsonSchemaOverride = NonNullable<z.core.ToJSONSchemaParams["override"]>;

const openObjects: JsonSchemaOverride = ({ zodSchema, jsonSchema }) => {
  if (
    zodSchema._zod.def.type === "object" &&
    jsonSchema.additionalProperties === false
  ) {
    delete jsonSchema.additionalProperties;
  }
};

/**
 * Wraps a tool's output schema so `tools/list` advertises open objects.
 *
 * Zod lists every `z.object` in an output schema with
 * `additionalProperties: false`. SDK clients validate each result against
 * the schema they cached when they listed tools, so an output field added in
 * a later deploy fails every call from a client that still holds the older
 * list (getsentry/toolkit#2293). Without that keyword, adding a field is
 * backward compatible, and the listed schema still catches missing or
 * mistyped fields. Server-side validation stays with the Zod schema.
 */
export function openOutputSchema(
  schema: ToolOutputSchema,
): StandardSchemaWithJSON {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        input: standard.jsonSchema.input,
        output: (options) =>
          standard.jsonSchema.output({
            ...options,
            libraryOptions: {
              ...options.libraryOptions,
              override: openObjects,
            },
          }),
      },
    },
  };
}
