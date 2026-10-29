import CodeSnippet from "../../ui/code-snippet";

interface CodexCLIInstructionsProps {
  transport: "cloud" | "stdio";
}

export function CodexCLIInstructions({ transport }: CodexCLIInstructionsProps) {
  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    const codexRemoteConfigToml = [
      "[mcp_servers.sentry]",
      `url = "${endpoint}"`,
    ].join("\n");

    return (
      <>
        <ol>
          <li>Open your terminal to access the CLI.</li>
          <li>
            <CodeSnippet
              noMargin
              snippet={`codex mcp add sentry --url ${endpoint}`}
            />
          </li>
          <li>
            Next time you run <code>codex</code>, the Sentry MCP server will be
            available. It will automatically open the OAuth flow to connect to
            your Sentry account.
          </li>
        </ol>
        Or
        <ol>
          <li>
            Edit <code>~/.codex/config.toml</code> and add the remote MCP
            configuration:
            <CodeSnippet noMargin snippet={codexRemoteConfigToml} />
          </li>
          <li>
            Save the file and restart any running <code>codex</code> session
          </li>
          <li>
            Next time you run <code>codex</code>, the Sentry MCP server will be
            available. It will automatically open the OAuth flow to connect to
            your Sentry account.
          </li>
        </ol>
      </>
    );
  }

  // Stdio transport
  const codexConfigToml = [
    "[mcp_servers.sentry]",
    'command = "npx"',
    'args = ["@sentry/mcp-server@latest"]',
    'env = { SENTRY_ACCESS_TOKEN = "sentry-user-token", OPENAI_API_KEY = "your-openai-key" }',
  ].join("\n");
  const selfHostedEnvLine =
    'env = { SENTRY_ACCESS_TOKEN = "sentry-user-token", SENTRY_HOST = "sentry.example.com", OPENAI_API_KEY = "your-openai-key" }';

  return (
    <>
      <ol>
        <li>
          Edit <code>~/.codex/config.toml</code> and add the MCP server
          configuration:
          <CodeSnippet noMargin snippet={codexConfigToml} />
        </li>
        <li>
          Replace <code>sentry-user-token</code> with your Sentry User Auth
          Token. Add <code>SENTRY_HOST</code> if you run self-hosted Sentry.
          <CodeSnippet noMargin snippet={selfHostedEnvLine} />
        </li>
        <li>
          Restart any running <code>codex</code> session to load the new MCP
          configuration.
        </li>
      </ol>
    </>
  );
}
