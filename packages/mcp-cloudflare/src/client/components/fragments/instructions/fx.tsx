import { CLI_MCP_SNIPPET } from "../../../../constants";
import { Link } from "../../ui/base";
import CodeSnippet from "../../ui/code-snippet";

interface FxInstructionsProps {
  transport: "cloud" | "cli";
}

export function FxInstructions({ transport }: FxInstructionsProps) {
  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    return (
      <>
        <ol>
          <li>Open your terminal to access the CLI.</li>
          <li>
            <CodeSnippet
              noMargin
              snippet={`fx mcp add --transport http sentry ${endpoint}`}
            />
          </li>
          <li>
            This will trigger an OAuth authentication flow to connect fx to your
            Sentry account.
          </li>
          <li>
            You may need to manually authenticate if it doesn't happen
            automatically, which can be done via <code>/mcp auth sentry</code>.
          </li>
        </ol>
        <p>
          <small>
            For more details, see the{" "}
            <Link href="https://fx.sh/docs/capabilities/mcp">
              fx MCP documentation
            </Link>
            .
          </small>
        </p>
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
            snippet={`fx mcp add sentry ${CLI_MCP_SNIPPET}`}
          />
        </li>
        <li>
          Run <code>/mcp reload</code> to apply the change.
        </li>
      </ol>
    </>
  );
}
