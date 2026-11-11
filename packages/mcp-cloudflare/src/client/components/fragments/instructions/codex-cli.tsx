import { CLI_MCP_SNIPPET } from "../../../../constants";
import CodeSnippet from "../../ui/code-snippet";

interface CodexCLIInstructionsProps {
  transport: "cloud" | "cli";
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

  return (
    <>
      <ol>
        <li>Open your terminal to access the CLI.</li>
        <li>
          <CodeSnippet
            noMargin
            snippet={`codex mcp add sentry -- ${CLI_MCP_SNIPPET}`}
          />
        </li>
        <li>
          Next time you run <code>codex</code>, the Sentry MCP server will be
          available, using your Sentry CLI login.
        </li>
      </ol>
    </>
  );
}
