import { Link } from "../../ui/base";
import CodeSnippet from "../../ui/code-snippet";
import { NPM_PACKAGE_NAME } from "../../../../constants";

interface ClaudeCodeInstructionsProps {
  transport: "cloud" | "stdio";
}

export function ClaudeCodeInstructions({
  transport,
}: ClaudeCodeInstructionsProps) {
  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    return (
      <>
        <ol>
          <li>Open your terminal to access the CLI.</li>
          <li>
            <CodeSnippet
              noMargin
              snippet={`claude mcp add --transport http sentry ${endpoint}`}
            />
          </li>
          <li>
            This will trigger an OAuth authentication flow to connect Claude
            Code to your Sentry account.
          </li>
          <li>
            You may need to manually authenticate if it doesnt happen
            automatically, which can be done via <code>/mcp</code>.
          </li>
        </ol>
        <p>
          <small>
            For more details, see the{" "}
            <Link href="https://docs.anthropic.com/en/docs/claude-code/mcp">
              Claude Code MCP documentation
            </Link>
            .
          </small>
        </p>
      </>
    );
  }

  // Stdio transport
  const mcpStdioSnippet = `npx ${NPM_PACKAGE_NAME}@latest`;
  return (
    <>
      <ol>
        <li>Open your terminal to access the CLI.</li>
        <li>
          <CodeSnippet
            noMargin
            snippet={`claude mcp add sentry -e SENTRY_ACCESS_TOKEN=sentry-user-token -e OPENAI_API_KEY=your-openai-key -- ${mcpStdioSnippet}`}
          />
        </li>
        <li>
          Replace <code>sentry-user-token</code> with your actual User Auth
          Token.
        </li>
        <li>
          Connecting to self-hosted Sentry? Append
          <code>-e SENTRY_HOST=your-hostname</code>.
        </li>
      </ol>
      <p>
        <small>
          For more details, see the{" "}
          <Link href="https://docs.anthropic.com/en/docs/claude-code/mcp">
            Claude Code MCP documentation
          </Link>
          .
        </small>
      </p>
    </>
  );
}
