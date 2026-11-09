#!/usr/bin/env tsx
/**
 * Measure token cost of MCP tool definitions.
 *
 * Calculates the static overhead of the MCP server by counting tokens
 * in the tool definitions that would be sent to LLM clients.
 *
 * Usage:
 *   tsx measure-token-cost.ts              # Display table
 *   tsx measure-token-cost.ts -o stats.json # Write JSON to file
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Tiktoken, encoding_for_model } from "tiktoken";
import { type ZodTypeAny, z } from "zod";

// Lazy imports to avoid type bleed
const toolsModule = await import("../src/tools/index.ts");
const surfacesModule = await import("../src/tools/surfaces.ts");
const toolTypesModule = await import("../src/tools/types.ts");

/**
 * Parse CLI arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  let outputFile: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output" || arg === "-o") {
      outputFile = args[i + 1];
      if (!outputFile) {
        throw new Error("--output requires a file path");
      }
      i++; // Skip next arg
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: tsx measure-token-cost.ts [options]

Options:
  -o, --output <file>  Write JSON output to file
  -h, --help          Show this help message

Examples:
  tsx measure-token-cost.ts              # Display table
  tsx measure-token-cost.ts -o stats.json # Write JSON to file
`);
      process.exit(0);
    }
  }

  return { outputFile };
}

type ToolDefinition = {
  name: string;
  title: string;
  description: string | ((context: { experimentalMode: boolean }) => string);
  inputSchema: Record<string, ZodTypeAny>;
  outputSchema?: ZodTypeAny;
  experimental?: boolean;
  hideInExperimentalMode?: boolean;
  deprecated?: { replacedBy: readonly string[] };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

/**
 * Format tool definitions as they would appear in MCP tools/list response.
 * This is what the LLM client actually receives and processes.
 */
function formatToolsForMCP(tools: Record<string, ToolDefinition>) {
  return Object.entries(tools).map(([_key, tool]) => {
    const inputSchema = tool.inputSchema || {};
    const zodObject =
      Object.keys(inputSchema).length > 0
        ? z.object(inputSchema)
        : z.object({});
    // Use the same options as the MCP SDK to match actual payload
    const jsonSchema = z.toJSONSchema(zodObject, {
      io: "input",
      unrepresentable: "any",
    });

    return {
      name: tool.name,
      title: tool.title,
      description: toolTypesModule.resolveDescription(tool.description, {
        experimentalMode: false,
      }),
      inputSchema: jsonSchema,
      // matches @modelcontextprotocol/server's
      // standardSchemaToJsonSchema(schema, "output") (draft-2020-12)
      ...(tool.outputSchema && {
        outputSchema: z.toJSONSchema(tool.outputSchema, { io: "output" }),
      }),
      ...(tool.annotations && { annotations: tool.annotations }),
    };
  });
}

/**
 * Count tokens in a string using tiktoken (GPT-4 tokenizer).
 */
function countTokens(text: string, encoder: Tiktoken): number {
  const tokens = encoder.encode(text);
  return tokens.length;
}

/**
 * Format table output for console display
 */
function formatTable(
  totalTokens: number,
  toolCount: number,
  avgTokensPerTool: number,
  tools: Array<{ name: string; tokens: number; percentage: number }>,
): string {
  const lines: string[] = [];

  // Header
  lines.push("\n📊 MCP Server Token Cost Report\n");
  lines.push("━".repeat(60));

  // Summary
  lines.push(`Total Tokens:     ${totalTokens.toLocaleString()}`);
  lines.push(`Tool Count:       ${toolCount}`);
  lines.push(`Average/Tool:     ${avgTokensPerTool}`);
  lines.push("━".repeat(60));

  // Table header
  lines.push("");
  lines.push("Per-Tool Breakdown:");
  lines.push("");
  lines.push("┌─────────────────────────────┬────────┬─────────┐");
  lines.push("│ Tool                        │ Tokens │ % Total │");
  lines.push("├─────────────────────────────┼────────┼─────────┤");

  // Table rows
  for (const tool of tools) {
    const name = tool.name.padEnd(27);
    const tokens = tool.tokens.toString().padStart(6);
    const percentage = `${tool.percentage}%`.padStart(7);
    lines.push(`│ ${name} │ ${tokens} │ ${percentage} │`);
  }

  lines.push("└─────────────────────────────┴────────┴─────────┘");

  return lines.join("\n");
}

async function main() {
  let encoder: Tiktoken | null = null;

  try {
    const { outputFile } = parseArgs();

    // Load tools
    const toolsDefault = toolsModule.default as
      | Record<string, ToolDefinition>
      | undefined;
    if (!toolsDefault || typeof toolsDefault !== "object") {
      throw new Error("Failed to import tools from src/tools/index.ts");
    }

    const toolsToMeasure = Object.fromEntries(
      Object.entries(toolsDefault).filter(
        ([, tool]) =>
          surfacesModule.isTopLevelTool(tool, false) &&
          toolTypesModule.isToolVisibleInMode(tool, false),
      ),
    );

    // Format as MCP would send them (as a complete tools array)
    const mcpTools = formatToolsForMCP(toolsToMeasure);

    // Wrap in tools array like MCP protocol does
    const toolsPayload = { tools: mcpTools };

    // Initialize tiktoken with GPT-4 encoding (cl100k_base)
    encoder = encoding_for_model("gpt-4");

    // Also calculate per-tool breakdown for reporting
    const toolStats = mcpTools.map((tool) => {
      const toolJson = JSON.stringify(tool);
      const tokens = countTokens(toolJson, encoder!);

      return {
        name: tool.name,
        tokens,
        json: toolJson,
      };
    });

    // Calculate totals - use the complete payload with tools array wrapper
    const payloadJson = JSON.stringify(toolsPayload);
    const totalTokens = countTokens(payloadJson, encoder);
    const toolCount = toolStats.length;
    const avgTokensPerTool = Math.round(totalTokens / toolCount);

    // Calculate percentages
    const toolsWithPercentage = toolStats.map((tool) => ({
      name: tool.name,
      tokens: tool.tokens,
      percentage: Number(((tool.tokens / totalTokens) * 100).toFixed(1)),
    }));

    // Sort by tokens (descending)
    toolsWithPercentage.sort((a, b) => b.tokens - a.tokens);

    // Build output data
    const output = {
      total_tokens: totalTokens,
      tool_count: toolCount,
      avg_tokens_per_tool: avgTokensPerTool,
      tools: toolsWithPercentage,
    };

    if (outputFile) {
      // Write JSON to file
      const absolutePath = path.resolve(outputFile);
      fs.writeFileSync(absolutePath, JSON.stringify(output, null, 2));
      console.log(`✅ Token stats written to: ${absolutePath}`);
      console.log(
        `   Total: ${totalTokens.toLocaleString()} tokens across ${toolCount} tools`,
      );
    } else {
      // Display table
      console.log(
        formatTable(
          totalTokens,
          toolCount,
          avgTokensPerTool,
          toolsWithPercentage,
        ),
      );
    }
  } catch (error) {
    const err = error as Error;
    console.error("[ERROR]", err.message, err.stack);
    process.exit(1);
  } finally {
    // Free encoder resources
    if (encoder) {
      encoder.free();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
