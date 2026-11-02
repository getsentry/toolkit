import type { WorkerEntrypoint } from "cloudflare:workers";
import type { McpServer } from "@modelcontextprotocol/server";
import * as Sentry from "@sentry/cloudflare";
import {
  codeModeResultSchema,
  getCodeModeToolDefinitions,
  isCodeModeSkill,
} from "@sentry/mcp-core/code-mode";
import type { Skill } from "@sentry/mcp-core/skills";
import { logIssue } from "@sentry/mcp-core/telem/logging";
import type { ServerContext } from "@sentry/mcp-core/types";
import { readBoundedStream } from "@sentry/toolkit-core/mcp-limits";
import { ApiAuthorization } from "./authorization";
import { type ApiCall, ApiBroker, isSentWrite, isWriteMethod } from "./broker";
import { ExecutionGate } from "./execution";
import { SPEC_VERSION, SPEC_TEXT } from "./openapi";
import { sandboxSource } from "./sandbox";

declare class Sandbox extends WorkerEntrypoint {
  run(broker: ApiBroker | undefined, deadline: number): Promise<Response>;
}

/**
 * `ok` and `error` come from the sandbox (the program returned or failed);
 * `timeout` is the execution deadline; `internal_error` is everything else
 * and creates a Sentry issue.
 */
type Outcome = "ok" | "error" | "timeout" | "internal_error";

/**
 * Registers Code Mode on this request's MCP server when the connection grants
 * API Read or API Write. The handlers capture the request's token and policy,
 * so never share the server across users.
 */
export function registerCodeModeTools(
  server: McpServer,
  loader: WorkerLoader,
  context: ServerContext,
): void {
  const skills = new Set<Skill>(
    [...(context.grantedSkills ?? [])].filter(isCodeModeSkill),
  );
  // A project route can mutate shared resources (e.g. release files). OpenAPI
  // does not prove project isolation, so retain the existing scoped tools only.
  if (!skills.size || context.constraints.projectSlug) return;
  const allowWrites = skills.has("api-write");
  const apiBaseUrl = `${context.sentryProtocol ?? "https"}://${context.sentryHost ?? "sentry.io"}/api/0`;
  const authorization = new ApiAuthorization(context);

  async function evaluate(tool: string, code: string) {
    const execute = tool === "execute_sentry_code";
    const span = Sentry.getActiveSpan();
    const execution = new ExecutionGate();
    const broker = execute
      ? new ApiBroker({
          execution,
          apiBaseUrl,
          allowWrites,
          authorization,
        })
      : undefined;
    const hint =
      execute && allowWrites
        ? " Execution is not atomic: writes may already have completed. Inspect API state before retrying writes."
        : "";
    let outcome: Outcome = "ok";
    try {
      const value = await execution.run(async () => {
        const workerCode = {
          compatibilityDate: "2026-01-12",
          mainModule: "worker.js",
          modules: {
            "worker.js": sandboxSource(execute ? apiBaseUrl : undefined),
            "user.js": `export default (${code});`,
            ...(execute ? {} : { "spec.json.txt": { text: SPEC_TEXT } }),
          },
          // Cloudflare enforces these in production. Local workerd does not;
          // the trusted harness separately bounds HTTP calls and output size.
          limits: { cpuMs: 1_000, subRequests: execute ? 20 : 0 },
          globalOutbound: null,
        };
        const response = await loader
          .load(workerCode)
          .getEntrypoint<Sandbox>()
          .run(broker, execution.deadline);
        const body = await readBoundedStream(response.body, 55_000);
        if (!body) throw new Error("The sandbox result exceeds 55,000 bytes.");
        return codeModeResultSchema.parse(
          JSON.parse(new TextDecoder().decode(body)),
        );
      });
      if (value.error !== undefined) {
        outcome = "error";
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
      // The gate rejects with its own reason when the deadline closes it.
      const timedOut = error === execution.signal.reason;
      outcome = timedOut ? "timeout" : "internal_error";
      const eventId = timedOut
        ? undefined
        : logIssue(error, {
            loggerScope: ["code-mode", "execution"],
            extra: { tool, specVersion: SPEC_VERSION },
          });
      const message =
        error instanceof Error ? error.message : "Code execution failed.";
      // Same shape as sandbox failures, so the result matches outputSchema.
      const failure = {
        error:
          message.slice(0, 4_000) +
          hint +
          (eventId ? ` Event ID: ${eventId}` : ""),
        stats: {
          apiCalls: broker?.calls.length ?? 0,
          writesAttempted:
            broker?.calls.filter((call) => isWriteMethod(call.method)).length ??
            0,
        },
      };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(failure) }],
        structuredContent: failure,
      };
    } finally {
      execution.close();
      recordExecution(span, { tool, code, outcome, calls: broker?.calls });
    }
  }

  for (const [name, definition] of Object.entries(
    getCodeModeToolDefinitions({ allowWrites }),
  )) {
    server.registerTool(name, definition, ({ code }) => evaluate(name, code));
  }
}

/**
 * The tool span keeps what one execution did, for debugging it; the metrics
 * count every execution and API operation, unsampled, for deciding what
 * Code Mode needs next. Operations are path templates, never concrete URLs.
 */
function recordExecution(
  span: ReturnType<typeof Sentry.getActiveSpan>,
  {
    tool,
    code,
    outcome,
    calls,
  }: { tool: string; code: string; outcome: Outcome; calls?: ApiCall[] },
): void {
  span?.setAttributes({
    "gen_ai.tool.call.arguments.code": code,
    "app.code_mode.outcome": outcome,
    "app.code_mode.spec_version": SPEC_VERSION,
    ...(calls
      ? {
          "app.code_mode.api_calls": calls.length,
          "app.code_mode.writes": calls.filter(isSentWrite).length,
          "app.code_mode.operations": JSON.stringify(
            calls.map(
              ({ method, operation, status, denied }) =>
                `${method} ${operation} ${status}${denied ? " denied" : ""}`,
            ),
          ),
        }
      : {}),
  });
  Sentry.metrics.count("app.code_mode.execution", 1, {
    attributes: { tool, outcome },
  });
  for (const { method, operation, status, denied } of calls ?? []) {
    Sentry.metrics.count("app.code_mode.request", 1, {
      attributes: { method, operation, status, denied: denied !== undefined },
    });
  }
}
