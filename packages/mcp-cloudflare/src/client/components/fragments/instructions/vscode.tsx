import { CLI_MCP_SNIPPET } from "../../../../constants";
import { Button } from "../../ui/button";
import CodeSnippet from "../../ui/code-snippet";
import { KeyIcon } from "../../ui/key-icon";

interface VSCodeInstructionsProps {
  transport: "cloud" | "cli";
}

export function VSCodeInstructions({ transport }: VSCodeInstructionsProps) {
  const mcpServerName = import.meta.env.DEV ? "sentry-dev" : "sentry";

  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;

    const vsCodeHandler = `vscode:mcp/install?${encodeURIComponent(
      JSON.stringify({
        name: mcpServerName,
        serverUrl: endpoint,
      }),
    )}`;

    return (
      <>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            window.location.href = vsCodeHandler;
          }}
          className="mt-2 mb-2 bg-violet-300 text-black hover:bg-violet-400 hover:text-black"
        >
          Install in VSCode
        </Button>
        <p>
          If this doesn't work, you can manually add the server using the
          following steps:
        </p>
        <ol>
          <li>
            <strong>
              {" "}
              <KeyIcon>⌘</KeyIcon> + <KeyIcon>P</KeyIcon>
            </strong>{" "}
            and search for <strong>MCP: Add Server</strong>.
          </li>
          <li>
            Select <strong>HTTP (HTTP or Server-Sent Events)</strong>.
          </li>
          <li>
            Enter the following configuration, and hit enter
            <strong> {endpoint}</strong>
          </li>
          <li>
            Enter the name <strong>Sentry</strong> and hit enter.
          </li>
          <li>Allow the authentication flow to complete.</li>
          <li>
            Activate the server using <strong>MCP: List Servers</strong> and
            selecting <strong>Sentry</strong>, and selecting{" "}
            <strong>Start Server</strong>.
          </li>
        </ol>
      </>
    );
  }

  return (
    <>
      <ol>
        <li>
          <strong>
            <KeyIcon>⌘</KeyIcon> + <KeyIcon>P</KeyIcon>
          </strong>{" "}
          and search for <strong>MCP: Add Server</strong>.
        </li>
        <li>
          Select <strong>Command (stdio)</strong>.
        </li>
        <li>
          Enter the following command, and hit enter.
          <CodeSnippet noMargin snippet={CLI_MCP_SNIPPET} />
        </li>
        <li>
          Enter the name <strong>Sentry</strong> and hit enter.
        </li>
        <li>
          Activate the server using <strong>MCP: List Servers</strong> and
          selecting <strong>Sentry</strong>, and selecting{" "}
          <strong>Start Server</strong>.
        </li>
      </ol>
      <p>
        <small>Note: MCP is supported in VSCode 1.99 and above.</small>
      </p>
    </>
  );
}
