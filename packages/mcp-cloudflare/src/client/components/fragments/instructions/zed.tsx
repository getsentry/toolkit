import { CLI_MCP_ARGS, CLI_MCP_COMMAND } from "../../../../constants";
import CodeSnippet from "../../ui/code-snippet";
import { KeyIcon } from "../../ui/key-icon";

interface ZedInstructionsProps {
  transport: "cloud" | "stdio" | "cli";
}

export function ZedInstructions({ transport }: ZedInstructionsProps) {
  const mcpServerName = import.meta.env.DEV ? "sentry-dev" : "sentry";

  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    const zedInstructions = JSON.stringify(
      {
        context_servers: {
          [mcpServerName]: {
            url: endpoint,
          },
          settings: {},
        },
      },
      undefined,
      2,
    );

    return (
      <>
        <ol>
          <li>
            <strong>
              <KeyIcon>⌘</KeyIcon> + <KeyIcon>,</KeyIcon>
            </strong>{" "}
            to open Zed settings.
          </li>
          <li>
            <CodeSnippet noMargin snippet={zedInstructions} />
          </li>
        </ol>
      </>
    );
  }

  if (transport === "cli") {
    return (
      <>
        <ol>
          <li>
            <strong>
              <KeyIcon>⌘</KeyIcon> + <KeyIcon>,</KeyIcon>
            </strong>{" "}
            to open Zed settings.
          </li>
          <li>
            <CodeSnippet
              noMargin
              snippet={JSON.stringify(
                {
                  context_servers: {
                    [mcpServerName]: {
                      command: CLI_MCP_COMMAND,
                      args: CLI_MCP_ARGS,
                    },
                  },
                },
                undefined,
                2,
              )}
            />
          </li>
        </ol>
      </>
    );
  }

  // Stdio transport
  const defaultEnv = {
    SENTRY_ACCESS_TOKEN: "sentry-user-token",
    OPENAI_API_KEY: "your-openai-key",
  } as const;
  const coreConfig = {
    command: "npx",
    args: ["@sentry/mcp-server@latest"],
    env: defaultEnv,
  };

  return (
    <>
      <ol>
        <li>
          <strong>
            <KeyIcon>⌘</KeyIcon> + <KeyIcon>,</KeyIcon>
          </strong>{" "}
          to open Zed settings.
        </li>
        <li>
          <CodeSnippet
            noMargin
            snippet={JSON.stringify(
              {
                context_servers: {
                  [mcpServerName]: {
                    ...coreConfig,
                    env: {
                      ...coreConfig.env,
                    },
                  },
                  settings: {},
                },
              },
              undefined,
              2,
            )}
          />
        </li>
      </ol>
    </>
  );
}
