import {
  array,
  description,
  nullable,
  object,
  optional,
  pipe,
  string,
} from "valibot";
import { describe, expect, test } from "vitest";
import {
  extractSchemaFieldPaths,
  extractSchemaFields,
} from "../../script/lib/output-schema-fields.js";

describe("extractSchemaFields", () => {
  // `@sentry/api` 1.19.0+ wraps each described field as
  // `optional(pipe(schema, description(...)))`, keeping the OpenAPI
  // description's line breaks.
  const apiField = optional(
    pipe(
      object({ content: string() }),
      description("First line.\n\nSecond   paragraph\nwraps."),
    ),
  );

  test("collapses a multi-line API description to one line", () => {
    const [field] = extractSchemaFields(object({ formatted: apiField }));
    expect(field).toEqual({
      name: "formatted",
      type: "object",
      description: "First line. Second paragraph wraps.",
      optional: true,
    });
  });

  test("prefers a description the CLI adds over the API's", () => {
    const [field] = extractSchemaFields(
      object({ formatted: pipe(apiField, description("CLI description")) }),
    );
    expect(field?.description).toBe("CLI description");
  });
});

describe("extractSchemaFieldPaths", () => {
  test("lists nested fields in dot notation, through wrappers and arrays", () => {
    const schema = object({
      id: string(),
      metadata: optional(nullable(object({ title: string() }))),
      tags: array(object({ key: string(), value: string() })),
    });

    expect(extractSchemaFieldPaths(schema)).toEqual([
      "id",
      "metadata",
      "metadata.title",
      "tags",
      "tags.key",
      "tags.value",
    ]);
  });

  test("returns nothing for a schema that is not an object", () => {
    expect(extractSchemaFieldPaths(string())).toEqual([]);
  });
});
