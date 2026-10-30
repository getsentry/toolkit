#!/usr/bin/env tsx
/**
 * Generate tool and skill definitions JSON for external consumption.
 *
 * Outputs to src/ so they can be bundled and imported by clients and the Cloudflare app.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { type ZodTypeAny, z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lazy imports of server modules to avoid type bleed
const toolsModule = await import("../src/tools/index.ts");
const surfacesModule = await import("../src/tools/surfaces.ts");
const skillsModule = await import("../src/skills.ts");
const toolTypesModule = await import("../src/tools/types.ts");
// Hosted-only tools belong in remote plugin allowlists, not core/stdio exports.
const { CODE_MODE_TOOL_NAMES, CODE_MODE_SKILLS, getCodeModeToolDefinitions } =
  await import("../../mcp-cloudflare/src/code-mode/definitions.ts");

function writeJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function ensureDirExists(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function zodFieldMapToJsonSchema(
  fieldMap: Record<string, ZodTypeAny>,
): unknown {
  if (!fieldMap || Object.keys(fieldMap).length === 0) return {};
  const obj = z.object(fieldMap);
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(obj, {
    io: "input",
    target: "draft-7",
    unrepresentable: "any",
  });
  return jsonSchema;
}

// Plugin variants whose agent frontmatter gets synced by this script.
// Add new entries here when creating a new plugin variant.
const PLUGIN_AGENT_CONFIGS = [
  { dir: "sentry-mcp", experimentalMode: false },
  { dir: "sentry-mcp-experimental", experimentalMode: true },
] as const;
const PLUGINS_DIR = path.join(__dirname, "../../../plugins");

function agentConfigs() {
  return PLUGIN_AGENT_CONFIGS.map((config) => ({
    ...config,
    path: path.join(PLUGINS_DIR, config.dir, "agents/sentry-mcp.md"),
  }));
}

function agentPaths(): string[] {
  return agentConfigs().map((config) => config.path);
}

function byName<T extends { name: string }>(a: T, b: T) {
  return a.name.localeCompare(b.name);
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

type DefinitionTool = {
  name: string;
  description:
    | string
    | ((context: {
        experimentalMode: boolean;
        availableToolNames?: ReadonlySet<string>;
        directToolNames?: ReadonlySet<string>;
      }) => string);
  inputSchema: Record<string, ZodTypeAny>;
  outputSchema?: ZodTypeAny;
  skills: string[];
  includeInSkillDefinitions?: boolean;
  requiredScopes: string[];
  experimental?: boolean;
  hideInExperimentalMode?: boolean;
};

type ToolSurface = "direct" | "catalog";

function isEnabledByDefaultSkills(tool: { skills: string[] }): boolean {
  const defaultSkills = skillsModule.DEFAULT_SKILLS as readonly string[];
  return (
    Array.isArray(tool.skills) &&
    tool.skills.some((skill) => defaultSkills.includes(skill))
  );
}

function isSkillDefinitionTool(tool: DefinitionTool): boolean {
  return (
    !surfacesModule.isWrapperToolName(tool.name) &&
    !surfacesModule.isCatalogInfrastructureToolName(tool.name)
  );
}

function toolNamesFromEntries(
  entries: Array<[string, DefinitionTool]>,
): ReadonlySet<string> {
  return new Set(entries.flatMap(([toolKey, tool]) => [toolKey, tool.name]));
}

// Tools
function generateToolDefinitions({
  experimentalMode,
}: {
  experimentalMode: boolean;
}) {
  const toolsDefault = toolsModule.default as
    | Record<string, unknown>
    | undefined;
  if (!toolsDefault || typeof toolsDefault !== "object") {
    throw new Error("Failed to import tools from src/tools/index.ts");
  }

  const visibleEntries = Object.entries(toolsDefault).flatMap(
    ([key, tool]): Array<[string, DefinitionTool]> => {
      if (!tool || typeof tool !== "object") {
        throw new Error(`Invalid tool: ${key}`);
      }
      const t = tool as DefinitionTool;
      if (
        surfacesModule.isWrapperToolName(t.name) ||
        !toolTypesModule.isToolVisibleInMode(t, experimentalMode)
      ) {
        return [];
      }
      return [[key, t]];
    },
  );
  const directEntries = visibleEntries.filter(([, tool]) =>
    surfacesModule.isTopLevelToolName(tool.name, experimentalMode),
  );
  const availableToolNames = toolNamesFromEntries(visibleEntries);
  const directToolNames = toolNamesFromEntries(directEntries);

  const defs = visibleEntries.map(([, t]) => {
    const isDirect = directToolNames.has(t.name);
    const isCatalog =
      isSkillDefinitionTool(t) &&
      Array.isArray(t.skills) &&
      t.skills.length > 0;
    if (!isDirect && !isCatalog) {
      return null;
    }
    if (!Array.isArray(t.requiredScopes)) {
      throw new Error(`Tool '${t.name}' is missing requiredScopes array`);
    }
    const jsonSchema = zodFieldMapToJsonSchema(t.inputSchema || {});
    const surface: ToolSurface = isDirect ? "direct" : "catalog";
    return {
      name: t.name,
      description: toolTypesModule.resolveDescription(t.description, {
        experimentalMode,
        availableToolNames,
        directToolNames,
      }),
      // Export full JSON Schema under inputSchema for external docs
      inputSchema: jsonSchema,
      outputSchema: t.outputSchema
        ? (({ $schema: _, ...jsonSchema }) => jsonSchema)(
            z.toJSONSchema(t.outputSchema, {
              io: "output",
              target: "draft-7",
              unrepresentable: "any",
            }),
          )
        : undefined,
      // Preserve tool access requirements for UIs/docs
      requiredScopes: t.requiredScopes,
      // Preserve skill catalog membership and call surface for UIs/docs.
      skills: t.skills,
      surface,
    };
  });
  return defs.filter(isNonNull).sort(byName);
}

// Skills
async function generateSkillDefinitions() {
  const getSkillsArrayWithCounts =
    skillsModule.getSkillsArrayWithCounts as () => Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        defaultEnabled: boolean;
        deprecated?: boolean;
        hostedOnly?: boolean;
        order: number;
        toolCount?: number;
      }>
    >;

  if (typeof getSkillsArrayWithCounts !== "function") {
    throw new Error(
      "Failed to import getSkillsArrayWithCounts from src/skills.ts",
    );
  }

  const skills = await getSkillsArrayWithCounts();

  // Get tools to build tool arrays for each skill
  const toolsDefault = toolsModule.default as
    | Record<string, unknown>
    | undefined;
  if (!toolsDefault || typeof toolsDefault !== "object") {
    throw new Error("Failed to import tools from src/tools/index.ts");
  }

  const defaultVisibleEntries = Object.entries(toolsDefault).flatMap(
    ([key, tool]): Array<[string, DefinitionTool]> => {
      if (!tool || typeof tool !== "object") {
        throw new Error(`Invalid tool: ${key}`);
      }

      const t = tool as DefinitionTool;
      if (
        surfacesModule.isWrapperToolName(t.name) ||
        !toolTypesModule.isToolVisibleInMode(t, false)
      ) {
        return [];
      }

      return [[key, t]];
    },
  );
  const defaultDirectToolNames = toolNamesFromEntries(
    defaultVisibleEntries.filter(([, tool]) =>
      surfacesModule.isTopLevelToolName(tool.name, false),
    ),
  );

  // Build tools array for each skill
  const skillsWithTools = skills.map((skill) => {
    const skillTools: Array<{
      name: string;
      description: string;
      requiredScopes: string[];
    }> = [];

    const skillToolEntries = Object.entries(toolsDefault).filter(([, tool]) => {
      if (!tool || typeof tool !== "object") {
        return false;
      }

      const t = tool as DefinitionTool;
      return (
        isSkillDefinitionTool(t) &&
        t.includeInSkillDefinitions !== false &&
        Array.isArray(t.skills) &&
        t.skills.includes(skill.id)
      );
    });
    const skillToolNames = new Set(
      skillToolEntries.flatMap(([toolKey, tool]) => {
        const t = tool as DefinitionTool;
        return [toolKey, t.name];
      }),
    );
    const availableToolNames = new Set([
      ...skillToolNames,
      ...defaultDirectToolNames,
    ]);

    for (const [, tool] of skillToolEntries) {
      const t = tool as DefinitionTool;
      skillTools.push({
        name: t.name,
        description: toolTypesModule.resolveDescription(t.description, {
          experimentalMode: false,
          availableToolNames,
          directToolNames: defaultDirectToolNames,
        }),
        requiredScopes: Array.isArray(t.requiredScopes) ? t.requiredScopes : [],
      });
    }

    if (CODE_MODE_SKILLS.some((skillId) => skillId === skill.id)) {
      const definitions = getCodeModeToolDefinitions({
        allowWrites: skill.id === "api-write",
        authorizationRequired: true,
      });
      for (const [name, definition] of Object.entries(definitions)) {
        skillTools.push({
          name,
          description: definition.description,
          requiredScopes: [],
        });
      }
    }

    // Sort tools alphabetically by name
    skillTools.sort((a, b) => a.name.localeCompare(b.name));

    return {
      ...skill,
      ...(skill.hostedOnly ? { toolCount: skillTools.length } : {}),
      tools: skillTools,
    };
  });

  // Return sorted by order (already sorted but being explicit)
  return skillsWithTools.sort((a, b) => a.order - b.order);
}

function isUpToDate(outDir: string): boolean {
  const toolDefsPath = path.join(outDir, "toolDefinitions.json");
  const skillDefsPath = path.join(outDir, "skillDefinitions.json");

  // Check if output files exist
  if (!fs.existsSync(toolDefsPath) || !fs.existsSync(skillDefsPath)) {
    return false;
  }

  // Check agent frontmatter files exist
  const agents = agentPaths();
  for (const agentPath of agents) {
    if (!fs.existsSync(agentPath)) {
      return false;
    }
  }

  // Get oldest output modification time (JSON files + agent files)
  const outputMtimes = [
    fs.statSync(toolDefsPath).mtimeMs,
    fs.statSync(skillDefsPath).mtimeMs,
    ...agents.map((p) => fs.statSync(p).mtimeMs),
  ];
  const oldestOutputMtime = Math.min(...outputMtimes);

  // Check if any input files are newer than outputs
  const toolsDir = path.join(__dirname, "../src/tools");
  if (fs.existsSync(toolsDir)) {
    const checkDir = (dir: string): boolean => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!checkDir(fullPath)) return false;
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts")
        ) {
          const mtime = fs.statSync(fullPath).mtimeMs;
          if (mtime > oldestOutputMtime) return false;
        }
      }
      return true;
    };
    if (!checkDir(toolsDir)) return false;
  }

  // Check other input files
  const otherInputs = [
    path.join(__dirname, "../src/skills.ts"),
    path.join(__dirname, "../src/tools/surfaces.ts"),
    path.join(__dirname, "../src/tools/types.ts"),
    path.join(__dirname, "../../mcp-cloudflare/src/code-mode/definitions.ts"),
    path.join(
      __dirname,
      "../src/internal/tool-helpers/tool-call-formatting.ts",
    ),
    path.join(__dirname, "generate-definitions.ts"),
  ];
  for (const inputPath of otherInputs) {
    if (fs.existsSync(inputPath)) {
      const mtime = fs.statSync(inputPath).mtimeMs;
      if (mtime > oldestOutputMtime) return false;
    }
  }

  return true;
}

// Agent frontmatter sync — updates the allowedTools list in agent .md files
function syncAgentFrontmatter(agentPath: string, toolNames: string[]) {
  const content = fs.readFileSync(agentPath, "utf-8");
  const parts = content.split("---");
  if (parts.length < 3) {
    console.warn(`⚠️  Skipping ${agentPath}: no valid YAML frontmatter found`);
    return;
  }

  // parts[0] is empty (before first ---), parts[1] is frontmatter, rest is body
  const frontmatterStr = parts[1];
  const body = parts.slice(2).join("---");

  const frontmatter = YAML.parse(frontmatterStr) as Record<string, unknown>;
  frontmatter.allowedTools = toolNames;

  const updated = `---\n${YAML.stringify(frontmatter)}---${body}`;
  fs.writeFileSync(agentPath, updated);
}

async function main() {
  try {
    const outDir = path.join(__dirname, "../src");
    ensureDirExists(outDir);

    // Skip if outputs are up-to-date
    if (isUpToDate(outDir)) {
      console.log("✅ Definitions are up-to-date, skipping generation");
      return;
    }

    console.log("Generating tool and skill definitions...");

    const tools = generateToolDefinitions({ experimentalMode: false });
    const experimentalTools = generateToolDefinitions({
      experimentalMode: true,
    });
    const skills = await generateSkillDefinitions();

    writeJson(path.join(outDir, "toolDefinitions.json"), tools);
    writeJson(path.join(outDir, "skillDefinitions.json"), skills);

    // Sync allowedTools in agent frontmatter with the direct MCP surface that
    // is available under the default OAuth grant. Optional-skill tools remain
    // available through search_sentry_tools/execute_sentry_tool when the user grants them,
    // without advertising direct calls that many sessions cannot execute.
    const directTools = tools.filter((tool) => tool.surface === "direct");
    const experimentalDirectTools = experimentalTools.filter(
      (tool) => tool.surface === "direct",
    );
    const toolNames = [
      ...directTools.filter(isEnabledByDefaultSkills).map((t) => t.name),
      ...CODE_MODE_TOOL_NAMES,
    ].sort();
    const experimentalToolNames = [
      ...experimentalDirectTools
        .filter(isEnabledByDefaultSkills)
        .map((t) => t.name),
      ...CODE_MODE_TOOL_NAMES,
    ].sort();

    let agentsSynced = 0;
    for (const agentConfig of agentConfigs()) {
      if (fs.existsSync(agentConfig.path)) {
        syncAgentFrontmatter(
          agentConfig.path,
          agentConfig.experimentalMode ? experimentalToolNames : toolNames,
        );
        agentsSynced++;
      }
    }

    console.log(
      `✅ Generated: tools(${tools.length}), directTools(${directTools.length}), experimentalTools(${experimentalTools.length}), experimentalDirectTools(${experimentalDirectTools.length}), skills(${skills.length}), agents(${agentsSynced})`,
    );
  } catch (error) {
    const err = error as Error;
    console.error("[ERROR]", err.message, err.stack);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
