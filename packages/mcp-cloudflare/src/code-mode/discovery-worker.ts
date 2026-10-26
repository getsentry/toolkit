import { createMcpHandler } from "agents/mcp/server";
import { buildServer } from "../../../mcp-core/src/server";
import { ALL_SKILLS } from "../../../mcp-core/src/skills";
import { type CodeModeEnv, configuredUrl } from "./broker";
import { registerCodeModeTools } from "./worker";

/** Eval-only composition of the real catalog and HTTP Code Mode on one MCP. */
export default {
  async fetch(
    request: Request,
    env: CodeModeEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (route !== "/mcp" && route !== "/catalog/mcp") {
      return new Response("Not found", { status: 404 });
    }
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return new Response("Bearer token required", { status: 401 });

    const api = configuredUrl(env.API_BASE_URL);
    if (
      api.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) ||
      api.pathname.replace(/\/$/, "") !== "/api/0"
    ) {
      return new Response("Discovery evals require loopback HTTP fixtures", {
        status: 500,
      });
    }

    return await createMcpHandler(
      () => {
        const server = buildServer({
          sdkVersion: "v2",
          context: {
            accessToken: token,
            sentryHost: api.host,
            sentryProtocol: "http",
            grantedSkills: new Set(ALL_SKILLS),
            constraints: {},
            transport: "http",
          },
        });
        if (route === "/mcp") registerCodeModeTools(server, env, token);
        return server;
      },
      { route },
    )(request, env, ctx);
  },
} satisfies ExportedHandler<CodeModeEnv>;
