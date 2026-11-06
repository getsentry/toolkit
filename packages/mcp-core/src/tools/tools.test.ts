import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, test } from "vitest";
import catalogTools from "./catalog/index.js";
import {
  findIncompatibleJsonSchemaUnions,
  formatJsonSchemaUnionViolations,
  zodFieldMapToJsonSchema,
} from "./catalog-runtime/schema.js";
import * as tools from "./index.js";
import {
  EXPERIMENTAL_TOP_LEVEL_TOOL_NAMES,
  isDefaultTopLevelToolName,
  isTopLevelToolName,
  TOP_LEVEL_TOOL_NAMES,
  WRAPPER_TOOL_NAMES,
} from "./surfaces.js";
import {
  isToolVisibleInMode,
  MAX_TOOL_DESCRIPTION_LENGTH,
  resolveDescription,
} from "./types.js";

const PUBLIC_TOOL_HARD_LIMIT = 25;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = path.join(__dirname, "catalog");
const CATALOG_TOOL_SOURCE_FILE_ALIASES = {
  get_ai_conversation_details: "get_agent_conversation_details",
  search_ai_conversations: "search_agent_conversations",
} as const satisfies Record<string, string>;

function getCatalogToolSourceFiles(): string[] {
  return fs
    .readdirSync(CATALOG_DIR)
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        file !== "index.ts",
    )
    .sort();
}

function getCatalogToolSourceFileName(toolName: string): string {
  return `${toolName.replaceAll("_", "-")}.ts`;
}

test(`all tool descriptions under maximum length`, () => {
  for (const experimentalMode of [false, true]) {
    for (const tool of Object.values(tools.default)) {
      const length = resolveDescription(tool.description, {
        experimentalMode,
      }).length;
      assert(
        length <= MAX_TOOL_DESCRIPTION_LENGTH,
        `${tool.name} description must be at most ${MAX_TOOL_DESCRIPTION_LENGTH} characters in ${experimentalMode ? "experimental" : "stable"} mode (was ${length})`,
      );
    }
  }
});

// server.metadata.test.ts checks the titles of listed tools. These tools never
// appear in its tools/list: deprecated aliases, and the feedback tool, which
// is hidden without a telemetry DSN.
test("unlisted tools declare a unique display title", () => {
  const all = Object.values(tools.default);
  const unlisted = all.filter(
    (tool) => tool.deprecated || tool.name === "submit_feedback_to_sentry_team",
  );
  assert(unlisted.length > 0, "expected deprecated or hidden tools");
  for (const tool of unlisted) {
    assert(tool.title.trim(), `${tool.name} must define a non-empty title`);
    const owner = all.find(
      (other) => other !== tool && other.title === tool.title,
    );
    assert(!owner, `${tool.name} reuses the title of ${owner?.name}`);
  }
});

// server.metadata.test.ts checks that every hint is set.
test("no tool is both read-only and destructive", () => {
  for (const tool of Object.values(tools.default)) {
    assert(
      !(
        tool.annotations.readOnlyHint === true &&
        tool.annotations.destructiveHint === true
      ),
      `${tool.name} cannot be both read-only and destructive`,
    );
  }
});

// EXPOSE_ALL_TOOLS lists every tool and relies on harness tool search, so the
// limit applies to the gateway surface that the flag falls back to.
test("gateway tool count stays within the hard limit in all modes", () => {
  for (const experimentalMode of [false, true]) {
    const visibleTools = TOP_LEVEL_TOOL_NAMES.filter((toolName) =>
      isToolVisibleInMode(tools.default[toolName], experimentalMode),
    );

    assert(
      visibleTools.length <= PUBLIC_TOOL_HARD_LIMIT,
      `gateway tool count must stay at or below ${PUBLIC_TOOL_HARD_LIMIT} in ${experimentalMode ? "experimental" : "stable"} mode (was ${visibleTools.length})`,
    );
  }
});

test("central direct exposure policy references existing tools", () => {
  const toolNames = new Set(Object.keys(tools.default));

  for (const toolName of TOP_LEVEL_TOOL_NAMES) {
    assert(toolNames.has(toolName), `top-level tool '${toolName}' must exist`);
  }

  for (const toolName of EXPERIMENTAL_TOP_LEVEL_TOOL_NAMES) {
    assert(
      toolNames.has(toolName),
      `experimental top-level tool '${toolName}' must exist`,
    );
  }

  for (const toolName of WRAPPER_TOOL_NAMES) {
    assert(toolNames.has(toolName), `wrapper tool '${toolName}' must exist`);
    assert(
      !isDefaultTopLevelToolName(toolName),
      `wrapper tool '${toolName}' must not be directly exposed by default`,
    );
  }
});

test("deprecated tools point to existing replacements", () => {
  const toolsByName = new Map(
    Object.values(tools.default).map((tool) => [tool.name, tool]),
  );

  for (const tool of toolsByName.values()) {
    if (!tool.deprecated) {
      continue;
    }

    assert(
      tool.deprecated.replacedBy.length > 0,
      `deprecated tool '${tool.name}' must name at least one replacement`,
    );
    for (const replacement of tool.deprecated.replacedBy) {
      const replacementTool = toolsByName.get(replacement);
      assert(
        replacementTool,
        `deprecated tool '${tool.name}' points to missing tool '${replacement}'`,
      );
      assert(
        !replacementTool.deprecated,
        `deprecated tool '${tool.name}' points to deprecated tool '${replacement}'`,
      );
    }
  }
});

test("tool registry keys match tool names", () => {
  for (const [toolName, tool] of Object.entries(tools.default)) {
    assert.equal(
      tool.name,
      toolName,
      `tool registry key '${toolName}' must match tool name '${tool.name}'`,
    );
  }
});

test("direct tool input schemas ban root and nested JSON Schema unions", () => {
  for (const experimentalMode of [false, true]) {
    for (const tool of Object.values(tools.default)) {
      if (!isTopLevelToolName(tool.name, experimentalMode)) {
        continue;
      }

      const violations = findIncompatibleJsonSchemaUnions(
        zodFieldMapToJsonSchema(tool.inputSchema),
      );
      assert.deepEqual(
        violations,
        [],
        `${tool.name} input schema must not use root or nested anyOf/oneOf/allOf (found ${formatJsonSchemaUnionViolations(violations)})`,
      );
    }
  }
});

test("catalog tools have colocated inline snapshot baseline tests", () => {
  const aliasToolNames = new Set(Object.keys(CATALOG_TOOL_SOURCE_FILE_ALIASES));
  const canonicalTools = Object.values(catalogTools).filter(
    (tool) => !aliasToolNames.has(tool.name),
  );
  const expectedSourceFiles = canonicalTools
    .map((tool) => getCatalogToolSourceFileName(tool.name))
    .sort();

  assert.deepEqual(
    getCatalogToolSourceFiles(),
    expectedSourceFiles,
    "catalog tool source files must match the catalog registry",
  );

  for (const tool of canonicalTools) {
    const sourceFile = getCatalogToolSourceFileName(tool.name);
    const testFile = sourceFile.replace(/\.ts$/, ".test.ts");
    const testPath = path.join(CATALOG_DIR, testFile);

    assert(
      fs.existsSync(testPath),
      `catalog tool '${tool.name}' must have a colocated ${testFile}`,
    );

    const testContents = fs.readFileSync(testPath, "utf8");
    assert(
      testContents.includes("toMatchInlineSnapshot("),
      `catalog tool '${tool.name}' must include a baseline inline snapshot test in ${testFile}`,
    );
  }
});

test("catalog aliases reference existing canonical tools", () => {
  const catalogToolNames = new Set(Object.keys(catalogTools));

  for (const [toolName, canonicalToolName] of Object.entries(
    CATALOG_TOOL_SOURCE_FILE_ALIASES,
  )) {
    assert(
      catalogToolNames.has(toolName),
      `catalog alias '${toolName}' must exist`,
    );
    assert(
      catalogToolNames.has(canonicalToolName),
      `catalog alias '${toolName}' must reference an existing canonical tool`,
    );
  }
});
