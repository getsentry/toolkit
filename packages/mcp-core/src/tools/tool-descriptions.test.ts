import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { zodFieldMapToJsonSchema } from "./catalog-runtime/schema.js";
import tools from "./index.js";
import {
  MAX_PARAM_DESCRIPTION_LENGTH,
  MAX_TOOL_DESCRIPTION_LENGTH,
  resolveDescription,
} from "./types.js";

// Enforces the description rules in docs/contributing/adding-tools.md
// ("Descriptions and Params"). The failure messages are the fix instructions,
// so they name the fix and the shortcuts that only hide the problem.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, "tool-descriptions-baseline.json");

// Lengths that may exceed the limit, keyed by `tool` or `tool:param.path`.
// Shrink-only: an entry fails when the text grows, and fails when it is stale.
const baseline: Record<string, number> = JSON.parse(
  fs.readFileSync(BASELINE_PATH, "utf8"),
);

const FORBIDDEN_TAGS = ["<examples>", "<hints>"];

const allToolNames = new Set(Object.keys(tools));

type Measured = { key: string; length: number; limit: number };

function descriptionsOf(tool: (typeof tools)[keyof typeof tools]) {
  return [false, true].map((experimentalMode) =>
    resolveDescription(tool.description, {
      experimentalMode,
      availableToolNames: allToolNames,
      directToolNames: allToolNames,
    }),
  );
}

/** Every `description` in a JSON Schema, keyed by its property path. */
function collectParamDescriptions(
  schema: unknown,
  pathParts: string[],
  out: Map<string, string>,
): void {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    for (const item of schema) collectParamDescriptions(item, pathParts, out);
    return;
  }
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && pathParts.length > 0) {
    const key = pathParts.join(".");
    const existing = out.get(key);
    if (!existing || existing.length < record.description.length) {
      out.set(key, record.description);
    }
  }
  const properties = record.properties;
  if (properties && typeof properties === "object") {
    for (const [name, child] of Object.entries(properties)) {
      collectParamDescriptions(child, [...pathParts, name], out);
    }
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    collectParamDescriptions(record[keyword], pathParts, out);
  }
  if (record.items) {
    const last = pathParts.at(-1) ?? "";
    collectParamDescriptions(
      record.items,
      [...pathParts.slice(0, -1), `${last}[]`],
      out,
    );
  }
  if (
    record.additionalProperties &&
    typeof record.additionalProperties === "object"
  ) {
    collectParamDescriptions(
      record.additionalProperties,
      [...pathParts, "*"],
      out,
    );
  }
}

function paramDescriptionsOf(tool: (typeof tools)[keyof typeof tools]) {
  const out = new Map<string, string>();
  collectParamDescriptions(zodFieldMapToJsonSchema(tool.inputSchema), [], out);
  return out;
}

/**
 * True when text names an input field: the key in a code span, or a
 * camelCase or snake_case key as a bare word. A plain word such as "query"
 * in prose is not a field reference.
 */
function namesParam(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\`${escaped}(?![\\w-])`).test(text)) return true;
  return /[A-Z_]/.test(key) && new RegExp(`\\b${escaped}\\b`).test(text);
}

function measureAll(): Measured[] {
  const measured: Measured[] = [];
  for (const tool of Object.values(tools)) {
    const length = Math.max(...descriptionsOf(tool).map((d) => d.length));
    measured.push({
      key: tool.name,
      length,
      limit: MAX_TOOL_DESCRIPTION_LENGTH,
    });
    for (const [param, text] of paramDescriptionsOf(tool)) {
      measured.push({
        key: `${tool.name}:${param}`,
        length: text.length,
        limit: MAX_PARAM_DESCRIPTION_LENGTH,
      });
    }
  }
  return measured;
}

describe("tool descriptions", () => {
  const measured = measureAll();

  test("stay within the length limits", () => {
    const failures = measured.flatMap(({ key, length, limit }) => {
      const allowed = Math.max(limit, baseline[key] ?? 0);
      return length > allowed ? [`${key}: ${length} > ${allowed}`] : [];
    });
    expect(
      failures,
      "Cut the tool description to what the tool does and returns, and move field meaning into describe() on the param. Cut a param description to what the value is and its format or constraint; move cross-field rules into handler validation. Do not raise the baseline or split text into a computed string to pass.",
    ).toEqual([]);
  });

  test("baseline has no stale entries", () => {
    const byKey = new Map(measured.map((m) => [m.key, m]));
    const stale = Object.entries(baseline).flatMap(([key, recorded]) => {
      const current = byKey.get(key);
      if (!current) return [`${key}: no longer exists`];
      if (current.length <= current.limit) return [`${key}: now within limit`];
      if (current.length < recorded) {
        return [`${key}: shrank to ${current.length}, record that length`];
      }
      return [];
    });
    expect(
      stale,
      "Update tool-descriptions-baseline.json: delete entries within the limit and record shrunk lengths.",
    ).toEqual([]);
  });

  test("use no legacy steering blocks", () => {
    const failures = Object.values(tools).flatMap((tool) => {
      const texts = [
        ...descriptionsOf(tool),
        ...paramDescriptionsOf(tool).values(),
      ];
      return FORBIDDEN_TAGS.filter((tag) =>
        texts.some((text) => text.includes(tag)),
      ).map((tag) => `${tool.name}: ${tag}`);
    });
    expect(
      failures,
      "Delete <examples> and <hints>. The schema shows the call shape; put a format the model needs, such as search syntax, on the param.",
    ).toEqual([]);
  });

  test("do not name input fields", () => {
    const failures = Object.values(tools).flatMap((tool) => {
      const texts = descriptionsOf(tool);
      return Object.keys(tool.inputSchema)
        .filter((key) => texts.some((text) => namesParam(text, key)))
        .map((key) => `${tool.name}: ${key}`);
    });
    expect(
      failures,
      "Move what the tool description says about this field into describe() on the param, and remove the field name from the tool description.",
    ).toEqual([]);
  });
});
