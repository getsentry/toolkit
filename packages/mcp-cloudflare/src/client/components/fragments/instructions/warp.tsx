import CodeSnippet from "../../ui/code-snippet";

interface WarpInstructionsProps {
  transport: "cloud" | "stdio";
}

export function WarpInstructions({ transport }: WarpInstructionsProps) {
  if (transport === "cloud") {
    const endpoint = new URL("/mcp", window.location.href).href;
    const coreConfig = {
      url: endpoint,
    };

    return (
      <>
        <ol>
          <li>
            Open{" "}
            <a
              href="https://warp.dev"
              target="_blank"
              rel="noopener noreferrer"
            >
              Warp
            </a>{" "}
            and navigate to MCP server settings using one of these methods:
            <ul>
              <li>
                From Warp Drive: <strong>Personal → MCP Servers</strong>
              </li>
              <li>
                From Command Palette: search for{" "}
                <strong>Open MCP Servers</strong>
              </li>
              <li>
                From Settings: <strong>Settings → Agents → MCP servers</strong>
              </li>
            </ul>
          </li>
          <li>
            Click <strong>+ Add</strong> button.
          </li>
          <li>
            Select <strong>Streamable HTTP or SSE Server (URL)</strong>.
          </li>
          <li>
            <CodeSnippet
              noMargin
              snippet={JSON.stringify(
                {
                  Sentry: {
                    ...coreConfig,
                    headers: {},
                  },
                },
                undefined,
                2,
              )}
            />
          </li>
        </ol>
        <p>
          <small>
            For more details, see the{" "}
            <a
              href="https://docs.warp.dev/agent-platform/capabilities/mcp/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Warp MCP documentation
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
          Open{" "}
          <a href="https://warp.dev" target="_blank" rel="noopener noreferrer">
            Warp
          </a>{" "}
          and navigate to MCP server settings using one of these methods:
          <ul>
            <li>
              From Warp Drive: <strong>Personal → MCP Servers</strong>
            </li>
            <li>
              From Command Palette: search for <strong>Open MCP Servers</strong>
            </li>
            <li>
              From Settings: <strong>Settings → Agents → MCP servers</strong>
            </li>
          </ul>
        </li>
        <li>
          Click <strong>+ Add</strong> button.
        </li>
        <li>
          Select <strong>CLI Server (Command)</strong> option.
        </li>
        <li>
          <CodeSnippet
            noMargin
            snippet={JSON.stringify(
              {
                Sentry: {
                  ...coreConfig,
                  env: {
                    ...coreConfig.env,
                  },
                  working_directory: null,
                },
              },
              undefined,
              2,
            )}
          />
        </li>
      </ol>
      <p>
        <small>
          For more details, see the{" "}
          <a
            href="https://docs.warp.dev/agent-platform/capabilities/mcp/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Warp MCP documentation
          </a>
          .
        </small>
      </p>
    </>
  );
}
