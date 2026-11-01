/**
 * Public MCP metadata endpoints under `/.mcp/*` for external documentation sites.
 *
 * Combines generated core definitions with the hosted Code Mode definitions.
 * CORS is handled by the wrapper in index.ts (these paths are in PUBLIC_METADATA_PATHS),
 * so routes here only need to set content-specific headers like Cache-Control.
 */

import TOOL_DEFINITIONS from "@sentry/mcp-core/toolDefinitions";
import { Hono } from "hono";
import { z } from "zod";
import {
  CODE_MODE_SKILLS,
  getCodeModeToolDefinitions,
} from "../../code-mode/definitions";

const hostedTools = Object.entries(
  getCodeModeToolDefinitions({
    allowWrites: true,
    authorizationRequired: true,
  }),
).map(([name, { inputSchema, outputSchema, ...definition }]) => ({
  name,
  ...definition,
  inputSchema: toJsonSchema(inputSchema, "input"),
  outputSchema: toJsonSchema(outputSchema, "output"),
  // API permissions are checked per operation, not as one fixed tool scope.
  requiredScopes: [],
  skills: [...CODE_MODE_SKILLS],
  surface: "direct",
}));
const toolDefinitions = [...TOOL_DEFINITIONS, ...hostedTools].sort((a, b) =>
  a.name.localeCompare(b.name),
);

function toJsonSchema(schema: z.ZodType, io: "input" | "output") {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema, {
    io,
    target: "draft-7",
    unrepresentable: "any",
  });
  return jsonSchema;
}

function jsonResponse(json: unknown, status = 200) {
  const body = JSON.stringify(json);
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300", // 5 minutes
    },
  });
}

export default new Hono()
  // Index: advertise available endpoints
  .get("/", (c) =>
    jsonResponse({
      endpoints: ["/.mcp/tools.json"],
    }),
  )
  // Tools
  .get("/tools.json", (c) => jsonResponse(toolDefinitions));
