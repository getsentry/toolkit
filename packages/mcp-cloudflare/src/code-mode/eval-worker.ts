import { isCodeModeSkill } from "@sentry/mcp-core/code-mode";
import { buildServer } from "@sentry/mcp-core/server";
import { ALL_SKILLS, type Skill } from "@sentry/mcp-core/skills";
import type { ServerContext } from "@sentry/mcp-core/types";
import {
  MAX_MCP_REQUEST_BODY_BYTES,
  boundMcpRequestBody,
} from "@sentry/toolkit-core/mcp-limits";
import { createMcpHandler } from "agents/mcp/server";
import { registerCodeModeTools } from "./tools";

interface EvalEnv {
  LOADER: WorkerLoader;
  /** Loopback fixture origin and API prefix, e.g. http://127.0.0.1:8787/api/0. */
  API_BASE_URL: string;
}

const CATALOG_SKILLS = ALL_SKILLS.filter((skill) => !isCodeModeSkill(skill));

/** What each eval surface's connection granted. */
const SURFACES: Record<string, Skill[]> = {
  "/mcp": [...CATALOG_SKILLS, "api-write"],
  "/catalog/mcp": CATALOG_SKILLS,
  "/code-mode/mcp": ["api-write"],
};

/**
 * Eval-only composition: the same `buildServer()` and
 * `registerCodeModeTools()` calls as the hosted handler, with a context that
 * points at a loopback API fixture. OAuth and routing are not exercised.
 */
export default {
  async fetch(
    request: Request,
    env: EvalEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const route = new URL(request.url).pathname;
    const grantedSkills = SURFACES[route];
    if (!grantedSkills) return new Response("Not found", { status: 404 });
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return new Response("Bearer token required", { status: 401 });

    const api = new URL(env.API_BASE_URL);
    if (
      api.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) ||
      api.pathname.replace(/\/$/, "") !== "/api/0"
    ) {
      return new Response("Evals require loopback HTTP fixtures", {
        status: 500,
      });
    }

    const boundedRequest = await boundMcpRequestBody(request);
    if (boundedRequest instanceof Response) return boundedRequest;
    return await createMcpHandler(
      () => {
        const context: ServerContext = {
          accessToken: token,
          sentryHost: api.host,
          sentryProtocol: "http",
          grantedSkills: new Set(grantedSkills),
          constraints: {},
          transport: "http",
        };
        const server = buildServer({ context });
        registerCodeModeTools(server, env.LOADER, context);
        return server;
      },
      { route, maxRequestBodySize: MAX_MCP_REQUEST_BODY_BYTES },
    )(boundedRequest, env, ctx);
  },
} satisfies ExportedHandler<EvalEnv>;
