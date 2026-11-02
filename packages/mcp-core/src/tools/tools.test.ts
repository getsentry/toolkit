import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, test } from "vitest";
import { getCodeModeToolDefinitions } from "../code-mode.js";
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
import { isToolVisibleInMode, resolveDescription } from "./types.js";

// VSCode (via OpenAI) limits to 1024 characters, but its tough to hit that right now,
// so instead lets limit the blast damage and hope that e.g. OpenAI will increase the limit.
const DESCRIPTION_MAX_LENGTH = 2048;
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
        length < DESCRIPTION_MAX_LENGTH,
        `${tool.name} description must be less than ${DESCRIPTION_MAX_LENGTH} characters in ${experimentalMode ? "experimental" : "stable"} mode (was ${length})`,
      );
    }
  }
  // Hosted Code Mode tools are registered outside the tool registry.
  for (const allowWrites of [false, true]) {
    for (const [name, { description }] of Object.entries(
      getCodeModeToolDefinitions({ allowWrites }),
    )) {
      assert(
        description.length < DESCRIPTION_MAX_LENGTH,
        `${name} description must be less than ${DESCRIPTION_MAX_LENGTH} characters (was ${description.length})`,
      );
    }
  }
});

test("all tools declare complete MCP safety annotations", () => {
  for (const tool of Object.values(tools.default)) {
    // Every tool must declare readOnlyHint, destructiveHint, and openWorldHint
    // explicitly (true or false, never undefined). Filters and confirmation
    // gates rely on these, so an absent hint is a silent gap.
    assert(
      typeof tool.annotations.readOnlyHint === "boolean",
      `${tool.name} must define readOnlyHint (true or false, not undefined)`,
    );
    assert(
      typeof tool.annotations.destructiveHint === "boolean",
      `${tool.name} must define destructiveHint (true or false, not undefined)`,
    );
    assert(
      typeof tool.annotations.openWorldHint === "boolean",
      `${tool.name} must define openWorldHint (true or false, not undefined)`,
    );
    assert(
      !(
        tool.annotations.readOnlyHint === true &&
        tool.annotations.destructiveHint === true
      ),
      `${tool.name} cannot be both read-only and destructive`,
    );
  }
});

test("public tool count stays within the hard limit in all modes", () => {
  for (const experimentalMode of [false, true]) {
    const visibleTools = Object.entries(tools.default).filter(
      ([toolName, tool]) =>
        isTopLevelToolName(toolName, experimentalMode) &&
        isToolVisibleInMode(tool, experimentalMode),
    );

    assert(
      visibleTools.length <= PUBLIC_TOOL_HARD_LIMIT,
      `public non-agent tool count must stay at or below ${PUBLIC_TOOL_HARD_LIMIT} in ${experimentalMode ? "experimental" : "stable"} mode (was ${visibleTools.length})`,
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
