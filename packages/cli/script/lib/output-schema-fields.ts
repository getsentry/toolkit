/**
 * Read the field metadata of a valibot output schema: the fields `--help`,
 * `sentry help <cmd>` and the skill references list, and the paths
 * `--fields` completes.
 *
 * Build time only. `script/generate-output-schemas.ts` runs it over the
 * schemas in `src/output-schemas/` and writes the result to
 * `src/generated/output-schemas/`, which is what the CLI reads at runtime.
 */

import { type GenericSchema, getDescription } from "valibot";
import type { SchemaFieldInfo } from "../../src/lib/formatters/output.js";

/** Minimal structural view of a valibot schema's runtime shape. */
type ValibotSchemaNode = {
  type: string;
  /** Inner schema for wrapper types (optional / nullable / nullish). */
  wrapped?: ValibotSchemaNode;
  /** Member schemas for union / variant / picklist. */
  options?: unknown[];
  /** Item schema for array. */
  item?: ValibotSchemaNode;
  /** Field schemas for object / loose_object. */
  entries?: Record<string, ValibotSchemaNode>;
  /**
   * Pipe steps for a `SchemaWithPipe` (e.g. `pipe(string(), description(...))`
   * or the `pipe(unknown(), transform(Number), number())` coercion pattern).
   * Each step carries a `kind` of `"schema"`, `"validation"`, `"transformation"`,
   * or `"metadata"`.
   */
  pipe?: Array<{ type: string; kind: string }>;
};

/**
 * Resolve a piped schema (`pipe(...)`) to the node whose `type` reflects its
 * output — the last step with `kind === "schema"`. For the coercion pattern
 * `pipe(unknown(), transform(Number), number())` this is `number()`, not the
 * leading `unknown()`. Non-piped schemas are returned unchanged.
 */
function unwrapPipe(schema: ValibotSchemaNode): ValibotSchemaNode {
  if (!schema.pipe?.length) {
    return schema;
  }
  const schemaSteps = schema.pipe.filter((step) => step.kind === "schema");
  const last = schemaSteps.at(-1);
  return (last as ValibotSchemaNode | undefined) ?? schema;
}

/** Leaf-type name mapping for {@link valibotTypeToString}. */
const VALIBOT_TYPE_MAP: Record<string, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  object: "object",
  loose_object: "object",
  array: "array",
  record: "object",
  null: "null",
  unknown: "unknown",
  any: "any",
  picklist: "string",
  enum: "string",
  literal: "string",
};

/**
 * Resolve a valibot `union` into a deduplicated `" | "`-joined type string.
 *
 * Used by auto-generated `@sentry/api/valibot` schemas that represent nullable
 * fields as `union([string(), null_()])` instead of `nullable(string())`.
 */
function resolveValibotUnion(options: ValibotSchemaNode[]): {
  type: string;
  optional: boolean;
} {
  let optional = false;
  const parts: string[] = [];
  for (const opt of options) {
    const resolved = valibotTypeToString(opt);
    if (resolved.optional) {
      optional = true;
    }
    if (!parts.includes(resolved.type)) {
      parts.push(resolved.type);
    }
  }
  return { type: parts.join(" | "), optional };
}

/**
 * Map a valibot schema's runtime `type` to a human-readable string.
 *
 * Unwraps wrapper types (optional, nullable, nullish) and builds a composite
 * type string (e.g. "string | null" for `nullable(string())`). Delegates
 * union handling to {@link resolveValibotUnion}.
 */
function valibotTypeToString(input: ValibotSchemaNode): {
  type: string;
  optional: boolean;
} {
  // Resolve `pipe(...)` schemas (incl. the coercion pattern) to their output
  // schema before inspecting the type.
  const schema = input ? unwrapPipe(input) : input;
  if (!schema?.type) {
    return { type: "unknown", optional: false };
  }

  // Unwrap wrapper types recursively.
  if (schema.type === "optional" && schema.wrapped) {
    const inner = valibotTypeToString(schema.wrapped);
    return { type: inner.type, optional: true };
  }
  if (schema.type === "nullable" && schema.wrapped) {
    const inner = valibotTypeToString(schema.wrapped);
    const nullableType = inner.type.includes(" | null")
      ? inner.type
      : `${inner.type} | null`;
    return { type: nullableType, optional: inner.optional };
  }
  if (schema.type === "nullish" && schema.wrapped) {
    const inner = valibotTypeToString(schema.wrapped);
    const nullableType = inner.type.includes(" | null")
      ? inner.type
      : `${inner.type} | null`;
    return { type: nullableType, optional: true };
  }
  if (
    (schema.type === "union" || schema.type === "variant") &&
    schema.options?.length
  ) {
    return resolveValibotUnion(schema.options as ValibotSchemaNode[]);
  }

  return { type: VALIBOT_TYPE_MAP[schema.type] ?? "unknown", optional: false };
}

/**
 * Extract field metadata from a valibot object schema.
 *
 * Returns an array of {@link SchemaFieldInfo} describing each top-level
 * field's name, type, description, and optionality. Returns an empty
 * array for non-object schemas.
 *
 * @param schema - A valibot schema (typically `object({...})`)
 */
export function extractSchemaFields(schema: GenericSchema): SchemaFieldInfo[] {
  const node = schema as unknown as ValibotSchemaNode;

  if (node.type !== "object" && node.type !== "loose_object") {
    return [];
  }

  const entries = node.entries;
  if (!entries) {
    return [];
  }

  return Object.entries(entries).map(([name, fieldSchema]) => {
    const { type, optional } = valibotTypeToString(fieldSchema);
    return {
      name,
      type,
      description: findDescription(fieldSchema),
      optional,
    };
  });
}

/** Wrapper types {@link objectsOf} looks through to the schema they hold. */
const WRAPPER_TYPES = new Set(["optional", "nullable", "nullish", "array"]);

/**
 * The object schemas a value of `schema` can be: through pipes, wrappers,
 * array items (`--fields` paths reach into arrays), and union and variant
 * members.
 */
function objectsOf(schema: ValibotSchemaNode): ValibotSchemaNode[] {
  const node = unwrapPipe(schema);
  if (WRAPPER_TYPES.has(node.type)) {
    const inner = node.wrapped ?? node.item;
    return inner ? objectsOf(inner) : [];
  }
  if (node.type === "union" || node.type === "variant") {
    return (node.options as ValibotSchemaNode[]).flatMap(objectsOf);
  }
  return node.entries ? [node] : [];
}

/**
 * Every field path a valibot schema describes, in `--fields` dot notation:
 * each top-level field, then the fields of nested objects
 * (`metadata.title`), parents before children.
 *
 * @param schema - A valibot schema (typically `object({...})`)
 */
export function extractSchemaFieldPaths(schema: GenericSchema): string[] {
  const paths = new Set<string>();
  const visit = (node: ValibotSchemaNode, prefix: string) => {
    for (const { entries = {} } of objectsOf(node)) {
      for (const [name, field] of Object.entries(entries)) {
        paths.add(`${prefix}${name}`);
        visit(field, `${prefix}${name}.`);
      }
    }
  };
  visit(schema as unknown as ValibotSchemaNode, "");
  return [...paths];
}

/**
 * Find a `description()` pipe action for a field schema.
 *
 * `getDescription` does not recurse, and the description may sit under one or
 * more wrapper schemas — e.g. `optional(nullable(pipe(string(), description(...))))`
 * places it two `.wrapped` levels down. Walk the wrapper chain until a
 * description is found.
 *
 * Since `@sentry/api` 1.19.0, fields spread from its schemas carry their
 * OpenAPI description, which can span several lines. `--help` and the
 * skill reference table show each field on one line, so collapse whitespace.
 */
function findDescription(schema: ValibotSchemaNode): string | undefined {
  let node: ValibotSchemaNode | undefined = schema;
  while (node) {
    const description = getDescription(node as unknown as GenericSchema);
    if (description !== undefined) {
      return description.replace(/\s+/g, " ").trim();
    }
    node = node.wrapped;
  }
  return;
}
