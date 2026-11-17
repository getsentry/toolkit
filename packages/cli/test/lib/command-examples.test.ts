/**
 * `--help` examples name the running program; generated docs name `sentry`.
 */

import { afterEach, describe, expect, test } from "vitest";
import { setAppIdentity } from "../../src/lib/app-identity.js";
import { buildCommand } from "../../src/lib/command.js";
import { exampleSteps } from "../../src/lib/command-example.js";
import { useEnvSandbox } from "../helpers.js";

useEnvSandbox(["npm_command"]);

afterEach(() => {
  setAppIdentity({ name: "sentry", packageName: "sentry" });
});

const examples = [
  { description: "List issues", run: "issue list my-org/frontend" },
  {
    description: "Create, then finalize",
    run: ["release create 1.0", "release finalize 1.0"],
  },
  { description: "Fix permissions", run: { prefix: "sudo ", args: "cli fix" } },
];

/** The help text `buildCommand` renders for the examples above. */
function helpText(): string {
  const command = buildCommand({
    auth: false,
    docs: { brief: "Test command", examples },
    parameters: {},
    async *func() {
      yield null;
    },
  });
  return (command as unknown as { fullDescription: string }).fullDescription;
}

describe("command examples", () => {
  test("docs and skills name the sentry binary", () => {
    expect(examples.flatMap((e) => exampleSteps(e, "sentry"))).toEqual([
      "sentry issue list my-org/frontend",
      "sentry release create 1.0",
      "sentry release finalize 1.0",
      "sudo sentry cli fix",
    ]);
  });

  test("--help names @sentry/mcp-server's binary", () => {
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    const help = helpText();
    expect(help).toContain(
      "  sentry-mcp issue list my-org/frontend # List issues",
    );
    expect(help).toContain("  sentry-mcp release finalize 1.0");
    expect(help).toContain("  sudo sentry-mcp cli fix # Fix permissions");
    expect(help).not.toContain(" sentry ");
  });

  test("--help goes through npx when npx launched the process", () => {
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    process.env.npm_command = "exec";
    expect(helpText()).toContain(
      "  npx -y @sentry/mcp-server issue list my-org/frontend # List issues",
    );
  });
});
