#!/usr/bin/env node

import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
/**
 * CLI entry point for MCP QA: loads env, resolves transport/provider, then runs
 * either tool discovery or the test agent against a single MCP connection.
 */
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { sentryBeforeSend } from "@sentry/mcp-core/telem/sentry";
import * as Sentry from "@sentry/node";
import chalk from "chalk";
import { Command, Option } from "commander";
import { config } from "dotenv";
import { runAgent } from "./agent.js";
import { resolveAgentProvider } from "./agent-provider.js";
import { logError, logInfo } from "./logger.js";
import { connectToMCPServer } from "./mcp-test-client.js";
import { connectToRemoteMCPServer } from "./mcp-test-client-remote.js";
import { resolveTransportMode } from "./transport.js";
import type { MCPConnection } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../../");

// Load environment variables from multiple possible locations
// IMPORTANT: Do NOT use override:true as it would overwrite shell/CI environment variables
config(); // Try current directory first (.env in mcp-test-client)
config({ path: path.join(rootDir, ".env") }); // Also try root directory (fallback for shared values)

const program = new Command();

// OAuth support for MCP server (not Sentry directly)

program
  .name("mcp-test-client")
  .description("CLI tool to test Sentry MCP server")
  .version("0.0.1")
  .argument("[prompt]", "Prompt to send to the AI agent")
  .option("-m, --model <model>", "Override the AI model to use")
  .option("--access-token <token>", "Sentry access token")
  .addOption(
    new Option(
      "--transport <transport>",
      "Transport to use: auto, stdio, or http",
    )
      .choices(["auto", "stdio", "http"])
      .default("auto"),
  )
  .option(
    "--mcp-host <host>",
    "MCP server host",
    process.env.MCP_URL || "http://localhost:5173",
  )
  .option("--host <host>", "Sentry host for stdio transport")
  .option("--sentry-dsn <dsn>", "Sentry DSN for error reporting")
  .option("--experimental", "Enable experimental tools (/mcp?experimental=1)")
  .option(
    "--list-tools",
    "Connect to the MCP server, list available tools, and exit without using an LLM",
  )
  .action(async (prompt, options) => {
    try {
      const agentProvider = resolveAgentProvider(process.env);

      // Initialize Sentry with CLI-provided DSN if available
      const sentryDsn =
        options.sentryDsn ||
        process.env.SENTRY_DSN ||
        process.env.DEFAULT_SENTRY_DSN;

      const scopeContext = {
        "gen_ai.agent.name": "sentry-mcp-agent",
        "gen_ai.provider.name": agentProvider ?? "unknown",
      };

      Sentry.init({
        dsn: sentryDsn,
        tracesSampleRate: 1,
        beforeSend: sentryBeforeSend,
        initialScope: {
          tags: scopeContext,
          // SDK v11 does not copy scope tags onto streamed spans.
          attributes: scopeContext,
        },
        release: process.env.SENTRY_RELEASE,
        integrations: [
          Sentry.consoleIntegration(),
          Sentry.zodErrorsIntegration(),
          Sentry.vercelAIIntegration({
            recordInputs: true,
            recordOutputs: true,
          }),
        ],
        environment:
          process.env.SENTRY_ENVIRONMENT ??
          (process.env.NODE_ENV !== "production"
            ? "development"
            : "production"),
      });

      // Check for access token in priority order
      const accessToken =
        options.accessToken || process.env.SENTRY_ACCESS_TOKEN;
      const sentryHost = options.host || process.env.SENTRY_HOST;

      const transport = resolveTransportMode({
        requestedTransport: options.transport,
        accessToken,
      });
      const listToolsOnly = Boolean(options.listTools);

      if (!listToolsOnly && !agentProvider) {
        logError("No supported LLM provider is configured");
        console.log(
          chalk.yellow(
            "\nPlease set one provider in your .env file or environment:",
          ),
        );
        console.log(chalk.gray("OPENAI_API_KEY=your_openai_api_key"));
        console.log(chalk.gray("OPENROUTER_API_KEY=your_openrouter_api_key"));
        console.log(
          chalk.gray(
            "EMBEDDED_AGENT_PROVIDER=openrouter # required if multiple provider keys are set",
          ),
        );
        process.exit(1);
      }

      // Connect to MCP server
      let connection: MCPConnection;
      if (transport === "stdio") {
        connection = await connectToMCPServer({
          accessToken,
          host: sentryHost,
          sentryDsn: sentryDsn,
          useExperimental: options.experimental,
        });
      } else {
        connection = await connectToRemoteMCPServer({
          mcpHost: options.mcpHost,
          accessToken,
          useExperimental: options.experimental,
        });
      }

      // The tag reaches error events; setConversationId puts the ID on gen_ai spans.
      Sentry.setTag("gen_ai.conversation.id", connection.sessionId);
      Sentry.setConversationId(connection.sessionId);

      const agentConfig = {
        model: options.model,
        provider: agentProvider ?? "openai",
      };

      try {
        if (listToolsOnly) {
          const toolNames = Array.from(connection.tools.keys()).sort();
          logInfo("Available tools", `${toolNames.length} tools`);
          for (const toolName of toolNames) {
            console.log(chalk.gray(`  - ${toolName}`));
          }
        } else if (prompt) {
          // Single prompt mode
          await runAgent(connection, prompt, agentConfig);
        } else {
          // Interactive mode (default when no prompt provided)
          logInfo("Interactive mode", "type 'exit', 'quit', or Ctrl+D to end");
          console.log(); // Add extra newline after startup message

          const rl = readline.createInterface({ input, output });

          while (true) {
            try {
              const userInput = await rl.question(chalk.gray("> "));

              // Handle null input (Ctrl+D / EOF)
              if (userInput === null) {
                logInfo("Goodbye!");
                break;
              }

              if (
                userInput.toLowerCase() === "exit" ||
                userInput.toLowerCase() === "quit"
              ) {
                logInfo("Goodbye!");
                break;
              }

              if (userInput.trim()) {
                await runAgent(connection, userInput, agentConfig);
                // Add newline after response before next prompt
                console.log();
              }
            } catch (error) {
              // Handle EOF (Ctrl+D) which may throw an error
              if (
                (error as any).code === "ERR_USE_AFTER_CLOSE" ||
                (error instanceof Error && error.message?.includes("EOF"))
              ) {
                logInfo("Goodbye!");
                break;
              }
              throw error;
            }
          }

          rl.close();
        }
      } finally {
        // Always disconnect
        await connection.disconnect();
        // Ensure Sentry events are flushed
        await Sentry.flush(5000);
      }
    } catch (error) {
      const eventId = Sentry.captureException(error);
      logError(
        "Fatal error",
        `${error instanceof Error ? error.message : String(error)}. Event ID: ${eventId}`,
      );
      // Ensure Sentry events are flushed before exit
      await Sentry.flush(5000);
      process.exit(1);
    }
  });

// Handle uncaught errors
process.on("unhandledRejection", async (error) => {
  const eventId = Sentry.captureException(error);
  logError(
    "Unhandled error",
    `${error instanceof Error ? error.message : String(error)}. Event ID: ${eventId}`,
  );
  // Ensure Sentry events are flushed before exit
  await Sentry.flush(5000);
  process.exit(1);
});

program.parse(process.argv);
