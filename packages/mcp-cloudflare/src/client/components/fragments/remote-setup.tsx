import { Prose } from "../ui/prose";
import InstallTabs, { Tab } from "./install-tabs";
import { AmpInstructions } from "./instructions/amp";
// Import IDE instruction components
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

const mcpServerName = import.meta.env.DEV ? "sentry-dev" : "sentry";

export default function RemoteSetup() {
  const endpoint = new URL("/mcp", window.location.href).href;
  return (
    <>
      <Prose className="mb-6">
        <p>
          <strong>Path Constraints:</strong> Restrict the session to a specific
          organization or project by adding them to the URL path. This ensures
          all skills operate within the specified scope.
        </p>
        <ul>
          <li>
            <code>/:organization</code> — Limit to one organization
          </li>
          <li>
            <code>/:organization/:project</code> — Limit to a specific project
          </li>
        </ul>
        <p>
          <small>
            Note: When using path constraints, some tools are automatically
            hidden: <code>find_organizations</code> is excluded with org
            constraints, and <code>find_projects</code> is excluded with project
            constraints.
          </small>
        </p>
      </Prose>
    </>
  );
}

interface RemoteSetupTabsProps {
  selectedIde?: string;
  onIdeChange?: (ide: string) => void;
}

export function RemoteSetupTabs({
  selectedIde,
  onIdeChange,
}: RemoteSetupTabsProps) {
  return (
    <InstallTabs selectedTab={selectedIde} onTabChange={onIdeChange}>
      {/* Keep the primary IDEs first, then alphabetize within each group. */}
      <Tab id="claude-code" title="Claude Code">
        <ClaudeCodeInstructions transport="cloud" />
      </Tab>

      <Tab id="codex-cli" title="Codex">
        <CodexCLIInstructions transport="cloud" />
      </Tab>

      <Tab id="cursor" title="Cursor">
        <CursorInstructions transport="cloud" />
      </Tab>

      <Tab id="amp" title="Amp">
        <AmpInstructions transport="cloud" />
      </Tab>

      <Tab id="fx" title="fx">
        <FxInstructions transport="cloud" />
      </Tab>

      <Tab id="gemini" title="Gemini CLI">
        <GeminiInstructions transport="cloud" />
      </Tab>

      <Tab id="opencode" title="OpenCode">
        <OpenCodeInstructions transport="cloud" />
      </Tab>

      <Tab id="pi" title="Pi">
        <PiInstructions transport="cloud" />
      </Tab>

      <Tab id="vscode" title="VSCode">
        <VSCodeInstructions transport="cloud" />
      </Tab>

      <Tab id="warp" title="Warp">
        <WarpInstructions transport="cloud" />
      </Tab>

      <Tab id="zed" title="Zed">
        <ZedInstructions transport="cloud" />
      </Tab>
    </InstallTabs>
  );
}
