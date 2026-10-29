import skillDefinitions from "@sentry/mcp-core/skillDefinitions";
import { NPM_PACKAGE_NAME, SCOPES } from "../../../constants";
import { Link } from "../ui/base";
import CodeSnippet from "../ui/code-snippet";
import { Prose } from "../ui/prose";
import InstallTabs, { Tab } from "./install-tabs";

const mcpServerName = import.meta.env.DEV ? "sentry-dev" : "sentry";
const orderedSkills = [...skillDefinitions]
  .filter((skill) => !skill.deprecated)
  .sort((a, b) => a.order - b.order);

export default function StdioSetup() {
  const mcpStdioSnippet = `npx ${NPM_PACKAGE_NAME}@latest`;

  const selfHostedHostExample = [
    `${mcpStdioSnippet}`,
    "--access-token=sentry-user-token",
    "--host=sentry.example.com",
  ].join(" \\\n  ");

  return (
    <>
      <Prose className="mb-6">
        <p>
          The stdio client is made available on npm at{" "}
          <Link href={`https://www.npmjs.com/package/${NPM_PACKAGE_NAME}`}>
            {NPM_PACKAGE_NAME}
          </Link>
          .
        </p>
        <p>
          <strong>Note:</strong> The MCP is developed against the cloud service
          of Sentry. If you are self-hosting Sentry you may find some tool calls
          are either using outdated APIs, or otherwise using APIs not available
          in self-hosted.
        </p>

        <p>
          The CLI targets Sentry's hosted service by default. Add host overrides
          only when you run self-hosted Sentry.
        </p>

        <p>
          Create a User Auth Token in your account settings with the following
          scopes:
        </p>
        <p>
          <strong>AI-powered search:</strong> If you want the event search tools
          (<code>search_errors</code>, <code>search_traces</code>,{" "}
          <code>search_logs</code>, and so on) and <code>search_issues</code> to
          translate natural language queries, add an
          <code>OPENAI_API_KEY</code> next to your Sentry token. The rest of the
          MCP server works without it, so you can skip this step if you do not
          need those tools.
        </p>
        <ul>
          {Object.entries(SCOPES).map(([scope, description]) => (
            <li key={scope}>
              <strong>{scope}</strong> - {description}
            </li>
          ))}
        </ul>
        <p>Now wire up that token to the MCP configuration:</p>
        <CodeSnippet
          snippet={[
            `${mcpStdioSnippet}`,
            "--access-token=sentry-user-token",
          ].join(" \\\n  ")}
        />
        <div className="mt-6">
          <h4 className="text-base font-semibold text-slate-100">
            Using with Self-Hosted Sentry
          </h4>
          <p>
            You'll need to provide the hostname of your self-hosted Sentry
            instance:
          </p>
          <CodeSnippet snippet={selfHostedHostExample} />
        </div>

        <h4 className="mb-6 text-lg font-semibold text-slate-100">
          Configuration
        </h4>

        <div className="mt-6 space-y-6 text-sm text-slate-200">
          <section>
            <h5 className="font-semibold uppercase tracking-wide text-slate-300 text-xs">
              Core setup
            </h5>
            <dl className="mt-3 space-y-2">
              <dt className="font-medium text-slate-100">
                <code>--access-token</code> / <code>SENTRY_ACCESS_TOKEN</code>
              </dt>
              <dd className="text-slate-300">Required user auth token.</dd>

              <dt className="font-medium text-slate-100">
                <code>--host</code> / <code>SENTRY_HOST</code>
              </dt>
              <dd className="text-slate-300">
                Hostname override when you run self-hosted Sentry.
              </dd>

              <dt className="font-medium text-slate-100">
                <code>--sentry-dsn</code> / <code>SENTRY_DSN</code>
              </dt>
              <dd className="text-slate-300">
                Send telemetry elsewhere or disable it by passing an empty
                value.
              </dd>

              <dt className="font-medium text-slate-100">
                <code>OPENAI_API_KEY</code>
              </dt>
              <dd className="text-slate-300">
                Optional for the standard tools, but required for the AI-powered
                search tools (<code>search_errors</code>,{" "}
                <code>search_traces</code>, <code>search_logs</code>, etc. and{" "}
                <code>search_issues</code>). When unset, those tools stay hidden
                but everything else works as usual.
              </dd>
            </dl>
          </section>

          <section>
            <h5 className="font-semibold uppercase tracking-wide text-slate-300 text-xs">
              Constraints
            </h5>
            <dl className="mt-3 space-y-2">
              <dt className="font-medium text-slate-100">
                <code>--organization-slug</code>
              </dt>
              <dd className="text-slate-300">
                Scope all skills to a single organization (CLI only).
              </dd>

              <dt className="font-medium text-slate-100">
                <code>--project-slug</code>
              </dt>
              <dd className="text-slate-300">
                Scope all skills to a specific project within that organization
                (CLI only).
              </dd>
            </dl>
          </section>

          <section>
            <h5 className="font-semibold uppercase tracking-wide text-slate-300 text-xs">
              Permissions
            </h5>
            <p className="mt-3 text-slate-400">
              Use <code>--skills</code> (or <code>MCP_SKILLS</code>) to pick the
              tool bundles you want to expose. Separate skill ids with commas.
            </p>
            <dl className="mt-3 space-y-2">
              <dt className="font-medium text-slate-100">
                <code>--skills</code> / <code>MCP_SKILLS</code>
              </dt>
              <dd className="text-slate-300">
                Skills automatically grant the minimum scopes required by the
                selected tools. You can combine any of the following ids:
                <ul className="mt-3 list-disc space-y-1 pl-5 text-slate-400">
                  {orderedSkills.map((skill) => (
                    <li key={skill.id}>
                      <code>{skill.id}</code> – {skill.name}
                      {skill.defaultEnabled ? " (default)" : ""}
                      {skill.description ? `: ${skill.description}` : ""}
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>
          </section>
        </div>
        <p className="mt-4 text-sm text-slate-300">
          Need something else? Run{" "}
          <code>npx @sentry/mcp-server@latest --help</code> to view the full
          flag list.
        </p>
      </Prose>
    </>
  );
}

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

interface StdioSetupTabsProps {
  selectedIde?: string;
  onIdeChange?: (ide: string) => void;
}

export function StdioSetupTabs({
  selectedIde,
  onIdeChange,
}: StdioSetupTabsProps) {
  return (
    <InstallTabs selectedTab={selectedIde} onTabChange={onIdeChange}>
      {/* Keep the primary IDEs first, then alphabetize within each group. */}
      <Tab id="claude-code" title="Claude Code">
        <ClaudeCodeInstructions transport="stdio" />
      </Tab>

      <Tab id="codex-cli" title="Codex">
        <CodexCLIInstructions transport="stdio" />
      </Tab>

      <Tab id="cursor" title="Cursor">
        <CursorInstructions transport="stdio" />
      </Tab>

      <Tab id="amp" title="Amp">
        <AmpInstructions transport="stdio" />
      </Tab>

      <Tab id="fx" title="fx">
        <FxInstructions transport="stdio" />
      </Tab>

      <Tab id="gemini" title="Gemini CLI">
        <GeminiInstructions transport="stdio" />
      </Tab>

      <Tab id="opencode" title="OpenCode">
        <OpenCodeInstructions transport="stdio" />
      </Tab>

      <Tab id="pi" title="Pi">
        <PiInstructions transport="stdio" />
      </Tab>

      <Tab id="vscode" title="VSCode">
        <VSCodeInstructions transport="stdio" />
      </Tab>

      <Tab id="warp" title="Warp">
        <WarpInstructions transport="stdio" />
      </Tab>

      <Tab id="zed" title="Zed">
        <ZedInstructions transport="stdio" />
      </Tab>
    </InstallTabs>
  );
}
