import CodeSnippet from "../../ui/code-snippet";

interface OpenCodeInstructionsProps {
  transport: "cloud" | "stdio";
}

export function OpenCodeInstructions({ transport }: OpenCodeInstructionsProps) {
  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    return (
      <>
        <ol>
          <li>
            Edit <code>~/.config/opencode/opencode.json</code> and add the
            remote MCP server configuration:
            <CodeSnippet
              noMargin
              snippet={JSON.stringify(
                {
                  $schema: "https://opencode.ai/config.json",
                  mcp: {
                    sentry: {
                      type: "remote",
                      url: endpoint,
                      oauth: {},
                    },
                  },
                },
                undefined,
                2,
              )}
            />
          </li>
          <li>Save the file and restart OpenCode.</li>
          <li>
            Authenticate with Sentry by running:
            <CodeSnippet noMargin snippet="opencode mcp auth sentry" />
          </li>
          <li>
            This will open a browser window to complete the OAuth flow and
            connect OpenCode to your Sentry account.
          </li>
        </ol>
        <p>
          <small>
            For more details, see the{" "}
            <a
              href="https://opencode.ai/docs/mcp-servers"
              target="_blank"
              rel="noopener noreferrer"
            >
              OpenCode MCP documentation
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
          Edit <code>~/.config/opencode/opencode.json</code> and add the stdio
          MCP server configuration:
          <CodeSnippet
            noMargin
            snippet={JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                mcp: {
                  sentry: {
                    type: "stdio",
                    ...coreConfig,
                    env: {
                      ...coreConfig.env,
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
                mcp: {
                  sentry: {
                    type: "stdio",
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
        <li>Restart OpenCode to load the new configuration.</li>
      </ol>
      <p>
        <small>
          For more details, see the{" "}
          <a
            href="https://opencode.ai/docs/mcp-servers"
            target="_blank"
            rel="noopener noreferrer"
          >
            OpenCode MCP documentation
          </a>
          .
        </small>
      </p>
    </>
  );
}
