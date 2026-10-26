import type { WorkerEntrypoint } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import {
  ApiBroker,
  type CodeModeEnv,
  configuredUrl,
  readBoundedBody,
} from "./broker";
import {
  codeModeResultSchema,
  getCodeModeToolDefinitions,
} from "./definitions";
import { getSpec } from "./openapi";
import type { ApiAuthorization } from "./production";
import { sandboxSource } from "./sandbox";

export type { CodeModeEnv } from "./broker";

declare class Sandbox extends WorkerEntrypoint {
  run(broker?: ApiBroker): Promise<Response>;
}

/** Callbacks capture this request's bearer token; never share this server across users. */
export function registerCodeModeTools(
  server: McpServer,
  env: CodeModeEnv,
  token: string,
  authorization?: ApiAuthorization,
): void {
  async function evaluate(code: string, execute: boolean) {
    const hint =
      execute && env.CODE_MODE_ALLOW_WRITES === "true"
        ? " Execution is not atomic: writes may already have completed. Inspect API state before retrying writes."
        : "";
    try {
      const apiBase = configuredUrl(env.API_BASE_URL)
        .toString()
        .replace(/\/$/, "");
      const deadline = Date.now() + 30_000;
      const spec = execute ? undefined : await getSpec(env.OPENAPI_URL);
      const worker = env.LOADER.get(
        `sentry-code-mode-${crypto.randomUUID()}`,
        async () => ({
          compatibilityDate: "2026-01-12",
          mainModule: "worker.js",
          modules: {
            "worker.js": sandboxSource(execute ? apiBase : undefined),
            "user.js": `export default (${code});`,
            ...(spec ? { "spec.json": { json: spec } } : {}),
          },
          // Cloudflare enforces these in production. Local workerd does not;
          // the trusted harness separately bounds HTTP calls and output size.
          limits: { cpuMs: 1_000, subRequests: execute ? 20 : 0 },
          globalOutbound: null,
        }),
      );
      const broker = execute
        ? new ApiBroker({
            accessToken: token,
            deadline,
            apiBaseUrl: env.API_BASE_URL,
            allowWrites: env.CODE_MODE_ALLOW_WRITES === "true",
            authorization,
          })
        : undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        worker.getEntrypoint<Sandbox>().run(broker),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Execution deadline exceeded.")),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      const body = await readBoundedBody(response.body, 55_000);
      const value = codeModeResultSchema.parse(
        JSON.parse(new TextDecoder().decode(body)),
      );
      if (value.error !== undefined) {
        const failure = { ...value, error: value.error + hint };
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(failure) }],
          structuredContent: failure,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Code execution failed.";
      return {
        isError: true,
        content: [
          { type: "text" as const, text: message.slice(0, 4_000) + hint },
        ],
      };
    }
  }
  for (const [name, definition] of Object.entries(
    getCodeModeToolDefinitions({
      allowWrites: env.CODE_MODE_ALLOW_WRITES === "true",
      authorizationRequired: !!authorization,
    }),
  )) {
    server.registerTool(name, definition, ({ code }) =>
      evaluate(code, name === "execute_sentry_code"),
    );
  }
}

function buildServer(env: CodeModeEnv, token: string): McpServer {
  const server = new McpServer({
    name: "sentry-code-mode-experiment",
    version: "0.1.0",
  });
  registerCodeModeTools(server, env, token);
  return server;
}

/** Separate experimental entrypoint; this does not change the production OAuth MCP. */
export default {
  async fetch(
    request: Request,
    env: CodeModeEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp")
      return new Response("Not found", { status: 404 });
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token)
      return new Response("A direct Sentry API bearer token is required.", {
        status: 401,
      });
    return await createMcpHandler(() => buildServer(env, token), {
      route: "/mcp",
    })(request, env, ctx);
  },
} satisfies ExportedHandler<CodeModeEnv>;
