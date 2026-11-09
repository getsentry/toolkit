import { type ZodTypeAny, z } from "zod";

const UNION_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

export type JsonSchemaUnionViolation = {
  path: string;
  reason: "root-union" | "nested-union";
  keyword: (typeof UNION_KEYWORDS)[number];
};

export function zodFieldMapToJsonSchema(
  fieldMap: Record<string, ZodTypeAny>,
): Record<string, unknown> {
  const zodObject =
    Object.keys(fieldMap).length > 0 ? z.object(fieldMap) : z.object({});

  const { $schema: _, ...jsonSchema } = z.toJSONSchema(zodObject, {
    io: "input",
    target: "draft-7",
    unrepresentable: "any",
  });
  return jsonSchema;
}

/**
 * Find JSON Schema union shapes that known model APIs reject for tool schemas.
 *
 * Banned:
 * - root-level `anyOf` / `oneOf` / `allOf` (Anthropic rejects these)
 * - nested unions inside another union (for example union + nullable)
 *
 * Allowed:
 * - property-level flat unions such as `string | null` or `string | string[]`
 */
export function findIncompatibleJsonSchemaUnions(
  schema: unknown,
  path: string[] = [],
  insideUnion = false,
): JsonSchemaUnionViolation[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findIncompatibleJsonSchemaUnions(
        item,
        [...path, String(index)],
        insideUnion,
      ),
    );
  }

  const record = schema as Record<string, unknown>;
  const violations: JsonSchemaUnionViolation[] = [];
  const atRoot = path.length === 0;

  for (const keyword of UNION_KEYWORDS) {
    const branches = record[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }

    const nextPath = [...path, keyword];
    const pathLabel = nextPath.join(".");

    if (atRoot) {
      violations.push({
        path: pathLabel,
        reason: "root-union",
        keyword,
      });
    } else if (insideUnion) {
      violations.push({
        path: pathLabel,
        reason: "nested-union",
        keyword,
      });
    }

    violations.push(
      ...findIncompatibleJsonSchemaUnions(branches, nextPath, true),
    );
  }

  for (const [key, value] of Object.entries(record)) {
    if ((UNION_KEYWORDS as readonly string[]).includes(key)) {
      continue;
    }
    violations.push(
      ...findIncompatibleJsonSchemaUnions(value, [...path, key], insideUnion),
    );
  }

  return violations;
}

export function formatJsonSchemaUnionViolations(
  violations: JsonSchemaUnionViolation[],
): string {
  return violations
    .map((violation) => `${violation.path} (${violation.reason})`)
    .join(", ");
}
