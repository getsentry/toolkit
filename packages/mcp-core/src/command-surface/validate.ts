/**
 * Checks a value against the JSON Schema subset `command-catalog.json` uses.
 *
 * Hand-written rather than a general validator: the subset is small, the
 * messages can name what to pass instead, and the hosted MCP runs on Workers,
 * where validators that compile schemas with `new Function` do not run.
 */

import type { JsonSchema } from "../command-catalog";

/** Show at most this many allowed values or flag names in one message. */
const MAX_LISTED = 25;

function list(values: readonly string[]): string {
  const shown = values.slice(0, MAX_LISTED).join(", ");
  return values.length > MAX_LISTED
    ? `${shown}, and ${values.length - MAX_LISTED} more`
    : shown;
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function matchesType(type: JsonSchema["type"], value: unknown): boolean {
  switch (type) {
    case undefined:
      return true;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    default:
      return typeof value === type;
  }
}

function validateArray(
  schema: JsonSchema,
  value: unknown[],
  path: string,
  errors: string[],
): void {
  const prefix = schema.prefixItems ?? [];
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    const names = prefix
      .slice(0, schema.minItems)
      .map((item, index) => item.title ?? `#${index}`);
    errors.push(
      `${path}: expected at least ${schema.minItems} value(s)${names.length ? ` (${names.join(", ")})` : ""}, got ${value.length}`,
    );
  }
  value.forEach((item, index) => {
    const itemSchema = index < prefix.length ? prefix[index] : schema.items;
    if (itemSchema === false) {
      errors.push(
        `${path}: expected at most ${prefix.length} value(s), got ${value.length}`,
      );
      return;
    }
    if (itemSchema) {
      validateValue(itemSchema, item, `${path}[${index}]`, errors);
    }
  });
}

function validateObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (value[name] === undefined) {
      errors.push(`${path}.${name}: required`);
    }
  }
  for (const [name, item] of Object.entries(value)) {
    const itemPath = `${path}.${name}`;
    const itemSchema = properties[name];
    if (!itemSchema) {
      if (schema.additionalProperties === false) {
        const known = Object.keys(properties);
        errors.push(
          `${itemPath}: unknown${known.length ? ` (expected one of: ${list(known)})` : ""}`,
        );
      }
      continue;
    }
    if (item !== undefined) {
      validateValue(itemSchema, item, itemPath, errors);
    }
  }
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!matchesType(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    errors.push(
      `${path}: ${JSON.stringify(value)} is not allowed (expected one of: ${list(schema.enum)})`,
    );
    return;
  }
  if (Array.isArray(value)) {
    validateArray(schema, value, path, errors);
  } else if (schema.type === "object") {
    validateObject(schema, value as Record<string, unknown>, path, errors);
  }
}

/**
 * Every way `value` fails `schema`, as `path: problem` lines, with paths
 * starting at `root` (`params.flags.limit`).
 */
export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  root: string,
): string[] {
  const errors: string[] = [];
  validateValue(schema, value, root, errors);
  return errors;
}
