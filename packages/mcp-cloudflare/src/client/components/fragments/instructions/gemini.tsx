import CodeSnippet from "../../ui/code-snippet";

interface GeminiInstructionsProps {
  transport: "cloud" | "stdio";
}

export function GeminiInstructions({ transport }: GeminiInstructionsProps) {
  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    const sentryMCPConfig = {
      url: endpoint,
    };

    return (
      <>
        <ol>
          <li>
            Edit <code>~/.gemini/settings.json</code> and add the HTTP MCP
            server configuration:
            <CodeSnippet
              noMargin
              snippet={JSON.stringify(
                {
                  mcpServers: {
                    sentry: sentryMCPConfig,
                  },
                },
                undefined,
                2,
              )}
            />
          </li>
          <li>Save the file and restart Gemini CLI.</li>
          <li>
            Authenticate with Sentry by running:
            <CodeSnippet noMargin snippet="/mcp auth sentry" />
          </li>
          <li>
            This will open a browser window to complete the OAuth flow and
            connect Gemini CLI to your Sentry account.
          </li>
        </ol>
        <p>
          <small>
            For more details, see the{" "}
            <a
              href="https://github.com/google-gemini/gemini-cli"
              target="_blank"
              rel="noopener noreferrer"
            >
              Gemini CLI documentation
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
          Edit <code>~/.gemini/settings.json</code> and add the MCP server
          configuration:
          <CodeSnippet
            noMargin
            snippet={JSON.stringify(
              {
                mcpServers: {
                  sentry: {
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
        <li>Restart Gemini CLI to load the new configuration.</li>
      </ol>
      <p>
        <small>
          For more details, see the{" "}
          <a
            href="https://github.com/google-gemini/gemini-cli"
            target="_blank"
            rel="noopener noreferrer"
          >
            Gemini CLI documentation
          </a>
          .
        </small>
      </p>
    </>
  );
}
