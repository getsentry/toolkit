import type { WorkerEntrypoint } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import {
  MAX_MCP_REQUEST_BODY_SIZE,
  MAX_MCP_TOOL_INPUT_ELEMENTS,
} from "@sentry/mcp-core/constants";
import { createMcpHandler } from "agents/mcp/server";
import { ApiBroker, type CodeModeEnv } from "./broker";
import {
  codeModeResultSchema,
  getCodeModeToolDefinitions,
} from "./definitions";
import { ExecutionGate } from "./execution";
import { configuredUrl, limitMcpRequestBody, readBoundedBody } from "./http";
import { getSpec } from "./openapi";
import type { ApiAuthorization } from "./production";
import { sandboxSource } from "./sandbox";

export type { CodeModeEnv } from "./broker";

declare class Sandbox extends WorkerEntrypoint {
  run(broker: ApiBroker | undefined, deadline: number): Promise<Response>;
}

/** Callbacks capture this request's bearer token; never share this server across users. */
export function registerCodeModeTools(
  server: McpServer,
  env: CodeModeEnv,
  token: string,
  authorization?: ApiAuthorization,
): void {
  async function evaluate(code: string, execute: boolean) {
    const execution = new ExecutionGate();
    const hint =
      execute && env.CODE_MODE_ALLOW_WRITES === "true"
        ? " Execution is not atomic: writes may already have completed. Inspect API state before retrying writes."
        : "";
    try {
      const value = await execution.run(async () => {
        const apiBase = configuredUrl(env.API_BASE_URL)
          .toString()
          .replace(/\/$/, "");
        const spec = execute ? undefined : await getSpec(env.OPENAPI_URL);
        execution.assertOpen();
        const workerCode = {
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
        };
        const worker = env.LOADER.load(workerCode);
        const broker = execute
          ? new ApiBroker({
              accessToken: token,
              execution,
              apiBaseUrl: env.API_BASE_URL,
              allowWrites: env.CODE_MODE_ALLOW_WRITES === "true",
              authorization,
            })
          : undefined;
        const response = await worker
          .getEntrypoint<Sandbox>()
          .run(broker, execution.deadline);
        const body = await readBoundedBody(response.body, 55_000);
        return codeModeResultSchema.parse(
          JSON.parse(new TextDecoder().decode(body)),
        );
      });
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
    } finally {
      execution.close();
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
  const server = new McpServer(
    {
      name: "sentry-code-mode-experiment",
      version: "0.1.0",
    },
    { maxToolInputElements: MAX_MCP_TOOL_INPUT_ELEMENTS },
  );
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
    const boundedRequest = await limitMcpRequestBody(request);
    if (boundedRequest instanceof Response) return boundedRequest;
    return await createMcpHandler(() => buildServer(env, token), {
      route: "/mcp",
      maxRequestBodySize: MAX_MCP_REQUEST_BODY_SIZE,
    })(boundedRequest, env, ctx);
  },
} satisfies ExportedHandler<CodeModeEnv>;
