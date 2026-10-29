import CodeSnippet from "../../ui/code-snippet";
import { Button } from "../../ui/button";
import { KeyIcon } from "../../ui/key-icon";
import { KeyWord } from "../../ui/key-word";
import { getCursorDeepLink } from "../../../../client/utils";

interface CursorInstructionsProps {
  transport: "cloud" | "stdio";
}

export function CursorInstructions({ transport }: CursorInstructionsProps) {
  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    const sentryMCPConfig = {
      url: endpoint,
    };
    return (
      <>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            window.location.href = getCursorDeepLink(endpoint);
          }}
          className="mt-2 mb-2 bg-violet-300 text-black hover:bg-violet-400 hover:text-black"
        >
          Install in Cursor
        </Button>
        <ol>
          <li>
            Or manually:{" "}
            <strong>
              <KeyIcon>⌘</KeyIcon> + <KeyWord>Shift</KeyWord> +{" "}
              <KeyIcon>J</KeyIcon>
            </strong>{" "}
            to open Cursor Settings.
          </li>
          <li>
            Select <strong>Skills and Integrations</strong>.
          </li>
          <li>
            Select <strong>New MCP Server</strong>.
          </li>
          <li>
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
          <li>
            Optional: To use the service with <code>cursor-agent</code>:
            <CodeSnippet noMargin snippet={`cursor-agent mcp login sentry`} />
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
            <KeyIcon>⌘</KeyIcon> + <KeyWord>Shift</KeyWord> +{" "}
            <KeyIcon>J</KeyIcon>
          </strong>{" "}
          to open Cursor Settings.
        </li>
        <li>
          Select <strong>MCP Skills</strong>.
        </li>
        <li>
          Select <strong>New MCP Server</strong>.
        </li>
        <li>
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
      </ol>
    </>
  );
}
