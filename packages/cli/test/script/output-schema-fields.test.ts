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
  /** An `@sentry/api/valibot` field: its description sits inside the wrapper. */
  const apiField = optional(pipe(string(), description("API description")));

  test("uses the description the API schema gives a field", () => {
    expect(extractSchemaFields(object({ id: apiField }))).toEqual([
      {
        name: "id",
        type: "string",
        description: "API description",
        optional: true,
      },
    ]);
  });

  test("prefers a CLI description around the API field", () => {
    const schema = object({
      id: optional(pipe(apiField.wrapped, description("CLI description"))),
    });
    expect(extractSchemaFields(schema)[0]?.description).toBe("CLI description");
  });

  test("puts a multi-line description on one line", () => {
    const schema = object({
      id: pipe(string(), description("First line.\n\nSecond  line.\n")),
    });
    expect(extractSchemaFields(schema)[0]?.description).toBe(
      "First line. Second line.",
    );
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
