/**
 * A deliberately small Hono server for exercising `sentry local` manually.
 *
 * Run it with `SENTRY_SPOTLIGHT` pointed at a local server. It never sets a
 * DSN itself, so the caller controls whether events stay local or are also
 * sent to a configured Sentry project.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { captureException, init, logger, startSpan } from "@sentry/node";
import { Hono } from "hono";

const SERVICE_NAME = "local-agent-fixture";
const DEFAULT_PORT = 3030;

export function createLocalAgentServer() {
  const app = new Hono();

  app.get("/health", (c) => c.json({ service: SERVICE_NAME, status: "ok" }));

  app.get("/api/users/:id", (c) =>
    startSpan(
      {
        name: "SELECT users",
        op: "db.query",
        attributes: {
          "db.system.name": "sqlite",
          "db.operation.name": "SELECT",
          "db.query.summary": "SELECT id, name FROM users WHERE id = ?",
        },
      },
      () => {
        const id = c.req.param("id");
        logger.info("Fixture user loaded", { attributes: { id } });
        return c.json({ id, name: "Ada Lovelace", source: "fixture-db" });
      }
    )
  );

  app.post("/api/agent/run", async (c) => {
    const { prompt } = (await c.req.json()) as { prompt?: unknown };
    const safePrompt = typeof prompt === "string" ? prompt : "";

    return startSpan(
      {
        name: "agent.run",
        op: "gen_ai.invoke_agent",
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.agent.name": "fixture-agent",
          "gen_ai.provider.name": "sentry",
          "gen_ai.request.model": "fixture-model",
        },
      },
      async () => {
        logger.info("Fixture agent received a prompt", {
          attributes: { prompt_length: safePrompt.length },
        });

        const tool = await startSpan(
          {
            name: "tools/call search_files",
            op: "mcp.client",
            attributes: {
              "mcp.method.name": "tools/call",
              "gen_ai.tool.name": "search_files",
            },
          },
          async () => "search_files"
        );

        return c.json({
          answer: "The rate limit is configured in src/lib/rate-limit.ts.",
          tool,
        });
      }
    );
  });

  app.get("/api/broken", (c) =>
    startSpan({ name: "fixture.failure", op: "http.server" }, () => {
      const error = new Error("Intentional local-agent fixture failure");
      logger.error("Fixture request failed", {
        attributes: { scenario: "broken" },
      });
      captureException(error, {
        tags: { "fixture.scenario": "broken" },
      });
      return c.json(
        {
          error: "fixture_failure",
          message:
            "The fixture intentionally failed. Check sentry local for details.",
        },
        500
      );
    })
  );

  return app;
}

function startServer(): void {
  init({
    dsn: process.env.SENTRY_DSN,
    enableLogs: true,
    tracesSampleRate: 1,
  });

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  serve({ fetch: createLocalAgentServer().fetch, port, hostname: "127.0.0.1" });
  process.stderr.write(
    `Local agent fixture listening at http://127.0.0.1:${port}\n`
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  startServer();
}
