import { CLI_INSTALL_COMMAND, CLI_MCP_SNIPPET } from "../../../constants";
import { Link } from "../ui/base";
import CodeSnippet from "../ui/code-snippet";
import { Prose } from "../ui/prose";
import InstallTabs, { Tab } from "./install-tabs";
import { AmpInstructions } from "./instructions/amp";
import { ClaudeCodeInstructions } from "./instructions/claude-code";
import { CodexCLIInstructions } from "./instructions/codex-cli";
import { CursorInstructions } from "./instructions/cursor";
import { FxInstructions } from "./instructions/fx";
import { GeminiInstructions } from "./instructions/gemini";
import { OpenCodeInstructions } from "./instructions/opencode";
import { PiInstructions } from "./instructions/pi";
import { VSCodeInstructions } from "./instructions/vscode";
import { WarpInstructions } from "./instructions/warp";
import { ZedInstructions } from "./instructions/zed";

/** Install and log in to the Sentry CLI, before any client-specific step. */
export function CliInstallSteps() {
  return (
    <Prose className="mb-6">
      <ol>
        <li>
          Install the Sentry CLI:
          <CodeSnippet noMargin snippet={CLI_INSTALL_COMMAND} />
          <small>
            Or use <code>brew install getsentry/tools/sentry</code>,{" "}
            <code>npm install -g sentry</code>, or{" "}
            <code>irm https://cli.sentry.dev/install.ps1 | iex</code> on
            Windows. See the{" "}
            <Link href="https://cli.sentry.dev/getting-started/">
              CLI installation guide
            </Link>
            .
          </small>
        </li>
        <li>
          Log in. A fresh install from the script usually does this for you:
          <CodeSnippet noMargin snippet="sentry auth login" />
        </li>
        <li>
          Add <code>{CLI_MCP_SNIPPET}</code> to your client as a stdio MCP
          server:
        </li>
      </ol>
    </Prose>
  );
}

export default function CliSetup() {
  return (
    <Prose className="mb-6">
      <p>
        <code>{CLI_MCP_SNIPPET}</code> runs the same local MCP server as{" "}
        <code>@sentry/mcp-server</code>, using your Sentry CLI login. There is
        no token in the MCP config: the CLI refreshes the login as needed, and
        each tool call uses the logged-in account that can reach the
        organization it targets.
      </p>

      <h4 className="text-base font-semibold text-slate-100">
        Limit to an organization or project
      </h4>
      <p>Pass the target after the command:</p>
      <ul>
        <li>
          <code>{CLI_MCP_SNIPPET} my-org/</code> — Limit to one organization
        </li>
        <li>
          <code>{CLI_MCP_SNIPPET} my-org/my-project</code> — Limit to a specific
          project
        </li>
      </ul>

      <h4 className="text-base font-semibold text-slate-100">
        AI-powered search
      </h4>
      <p>
        The event search tools (<code>search_errors</code>,{" "}
        <code>search_traces</code>, <code>search_logs</code>, and so on) and{" "}
        <code>search_issues</code> translate natural-language queries when an
        LLM key such as <code>OPENAI_API_KEY</code> or{" "}
        <code>ANTHROPIC_API_KEY</code> is in the server's environment. Without
        one, they still work with Sentry search syntax.
      </p>

      <h4 className="text-base font-semibold text-slate-100">
        Self-hosted Sentry
      </h4>
      <p>
        Log in to your instance with{" "}
        <code>sentry auth login --url https://sentry.example.com</code>, then
        set <code>SENTRY_HOST</code> in the MCP server's environment. See the{" "}
        <Link href="https://cli.sentry.dev/self-hosted/">
          CLI self-hosted guide
        </Link>
        .
      </p>

      <p className="mt-4 text-sm text-slate-300">
        Run <code>{CLI_MCP_SNIPPET} --help</code> for every flag and environment
        variable. To run the server without installing the CLI, use{" "}
        <code>npx @sentry/mcp-server</code> as described in the{" "}
        <Link href="https://github.com/getsentry/toolkit#stdio-vs-remote">
          README
        </Link>
        .
      </p>
    </Prose>
  );
}

interface CliSetupTabsProps {
  selectedIde?: string;
  onIdeChange?: (ide: string) => void;
}

export function CliSetupTabs({ selectedIde, onIdeChange }: CliSetupTabsProps) {
  return (
    <InstallTabs selectedTab={selectedIde} onTabChange={onIdeChange}>
      {/* Keep the primary IDEs first, then alphabetize within each group. */}
      <Tab id="claude-code" title="Claude Code">
        <ClaudeCodeInstructions transport="cli" />
      </Tab>

      <Tab id="codex-cli" title="Codex">
        <CodexCLIInstructions transport="cli" />
      </Tab>

      <Tab id="cursor" title="Cursor">
        <CursorInstructions transport="cli" />
      </Tab>

      <Tab id="amp" title="Amp">
        <AmpInstructions transport="cli" />
      </Tab>

      <Tab id="fx" title="fx">
        <FxInstructions transport="cli" />
      </Tab>

      <Tab id="gemini" title="Gemini CLI">
        <GeminiInstructions transport="cli" />
      </Tab>

      <Tab id="opencode" title="OpenCode">
        <OpenCodeInstructions transport="cli" />
      </Tab>

      <Tab id="pi" title="Pi">
        <PiInstructions transport="cli" />
      </Tab>

      <Tab id="vscode" title="VSCode">
        <VSCodeInstructions transport="cli" />
      </Tab>

      <Tab id="warp" title="Warp">
        <WarpInstructions transport="cli" />
      </Tab>

      <Tab id="zed" title="Zed">
        <ZedInstructions transport="cli" />
      </Tab>
    </InstallTabs>
  );
}
