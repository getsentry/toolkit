import CodeSnippet from "../../ui/code-snippet";

interface PiInstructionsProps {
  transport: "cloud" | "stdio";
}

export function PiInstructions({ transport }: PiInstructionsProps) {
  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    return (
      <>
        <ol>
          <li>
            Open your terminal and add the Sentry MCP server:
            <CodeSnippet
              noMargin
              snippet={`pi mcp add sentry --url ${endpoint}`}
            />
          </li>
          <li>
            Authenticate with Sentry by running:
            <CodeSnippet noMargin snippet="pi mcp login sentry" />
          </li>
          <li>
            This will open a browser window to complete the OAuth flow and
            connect Pi to your Sentry account.
          </li>
          <li>
            Start Pi or run <code>/reload</code> in an existing session to load
            the new configuration.
          </li>
        </ol>
        <p>
          <small>
            For more details, see the{" "}
            <a
              href="https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              Pi MCP documentation
            </a>
            .
          </small>
        </p>
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
          Edit <code>~/.pi/agent/mcp.json</code> and add the stdio MCP server
          configuration:
          <CodeSnippet
            noMargin
            snippet={JSON.stringify(
              {
                mcpServers: {
                  sentry: coreConfig,
                },
              },
              undefined,
              2,
            )}
          />
        </li>
        <li>
          Replace <code>sentry-user-token</code> with your Sentry User Auth
          Token.
        </li>
        <li>
          For self-hosted Sentry, add <code>SENTRY_HOST</code> to the env
          object:
          <CodeSnippet
            noMargin
            snippet={JSON.stringify(
              {
                mcpServers: {
                  sentry: {
                    ...coreConfig,
                    env: {
                      ...coreConfig.env,
                      SENTRY_HOST: "sentry.example.com",
                    },
                  },
                },
              },
              undefined,
              2,
            )}
          />
        </li>
        <li>
          Start Pi or run <code>/reload</code> in an existing session to load
          the new configuration.
        </li>
      </ol>
      <p>
        <small>
          For more details, see the{" "}
          <a
            href="https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            Pi MCP documentation
          </a>
          .
        </small>
      </p>
    </>
  );
}
