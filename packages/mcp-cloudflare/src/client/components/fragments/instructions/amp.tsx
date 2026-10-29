import CodeSnippet from "../../ui/code-snippet";

interface AmpInstructionsProps {
  transport: "cloud" | "stdio";
}

export function AmpInstructions({ transport }: AmpInstructionsProps) {
  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    return (
      <>
        <ol>
          <li>
            Open your terminal and use the Amp CLI to add the Sentry MCP server:
            <CodeSnippet noMargin snippet={`amp mcp add sentry ${endpoint}`} />
          </li>
          <li>
            Amp will automatically initiate OAuth authentication using Dynamic
            Client Registration (DCR). Follow the browser prompts to authorize
            the connection.
          </li>
          <li>
            Once authenticated, the Sentry MCP server will be available in Amp.
          </li>
        </ol>
        <p>
          <small>
            For more details, see the{" "}
            <a
              href="https://ampcode.com/manual#mcp"
              target="_blank"
              rel="noopener noreferrer"
            >
              Amp MCP documentation
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
          Edit your settings file and add the MCP server configuration:
          <ul>
            <li>
              <strong>macOS/Linux:</strong>{" "}
              <code>~/.config/amp/settings.json</code>
            </li>
            <li>
              <strong>Windows:</strong>{" "}
              <code>%USERPROFILE%\.config\amp\settings.json</code>
            </li>
          </ul>
          <CodeSnippet
            noMargin
            snippet={JSON.stringify(
              {
                "amp.mcpServers": {
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
                "amp.mcpServers": {
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
        <li>Restart Amp to load the new configuration.</li>
      </ol>
      <p>
        <small>
          For more details, see the{" "}
          <a
            href="https://ampcode.com/manual#mcp"
            target="_blank"
            rel="noopener noreferrer"
          >
            Amp MCP documentation
          </a>
          .
        </small>
      </p>
    </>
  );
}
