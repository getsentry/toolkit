import { array, nullable, object, optional, string } from "valibot";
import { describe, expect, test } from "vitest";
import { extractSchemaFieldPaths } from "../../script/lib/output-schema-fields.js";

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
