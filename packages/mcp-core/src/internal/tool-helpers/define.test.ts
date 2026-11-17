import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { ToolRegistry } from "../../tools/catalog-runtime/availability";
import type { StructuredToolOutput } from "../../tools/types";
import { defineTool } from "./define";
import { structuredResult } from "./results";

// These cases are checked by `tsc`: each `@ts-expect-error` fails the build
// if the line it covers stops being a type error.

const outputSchema = z.object({
  id: z.string(),
  count: z.number(),
  url: z.string().nullable(),
  tags: z.array(z.string()).default([]),
});

const base = {
  title: "Test Tool",
  description: "Test tool.",
  skills: [],
  requiredScopes: [],
  inputSchema: { id: z.string() },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

describe("defineTool output typing", () => {
  it("types handler results from outputSchema without annotations", () => {
    const tool = defineTool({
      ...base,
      name: "typed_tool",
      outputSchema,
      async handler(params) {
        return structuredResult({
          id: params.id,
          count: 1,
          url: null,
          tags: [],
        });
      },
    });

    expectTypeOf(tool.handler).returns.resolves.toEqualTypeOf<
      StructuredToolOutput<z.output<typeof outputSchema>>
    >();
    expectTypeOf({ typed_tool: tool }).toExtend<ToolRegistry>();
  });

  it("rejects payloads that do not match outputSchema", () => {
    defineTool({
      ...base,
      name: "wrong_field_type",
      outputSchema,
      async handler(params) {
        return structuredResult({
          id: params.id,
          // @ts-expect-error count must be a number
          count: "1",
          url: null,
          tags: [],
        });
      },
    });

    defineTool({
      ...base,
      name: "missing_field",
      outputSchema,
      async handler(params) {
        // @ts-expect-error url is required by the schema
        return structuredResult({ id: params.id, count: 1, tags: [] });
      },
    });

    defineTool({
      ...base,
      name: "relies_on_default",
      outputSchema,
      async handler(params) {
        // @ts-expect-error tags has a default, but the SDK sends the raw
        // payload, so it must already match the schema's output
        return structuredResult({ id: params.id, count: 1, url: null });
      },
    });

    defineTool({
      ...base,
      name: "extra_field",
      outputSchema,
      async handler(params) {
        return structuredResult({
          id: params.id,
          count: 1,
          url: null,
          tags: [],
          // @ts-expect-error fields outside the schema must not leak
          email: "user@example.com",
        });
      },
    });

    defineTool({
      ...base,
      name: "own_content",
      outputSchema,
      // @ts-expect-error the server generates content from the payload
      async handler(params) {
        return {
          structuredContent: { id: params.id, count: 1, url: null, tags: [] },
          content: [{ type: "text" as const, text: "markdown" }],
        };
      },
    });
  });

  it("allows markdown only without outputSchema", () => {
    const markdownTool = defineTool({
      ...base,
      name: "markdown_tool",
      async handler(params) {
        return `# ${params.id}`;
      },
    });
    expectTypeOf(markdownTool.handler).returns.resolves.toExtend<string>();

    defineTool({
      ...base,
      name: "markdown_with_schema",
      outputSchema,
      // @ts-expect-error a tool with an outputSchema must return structured output
      async handler(params) {
        return `# ${params.id}`;
      },
    });
  });
});
