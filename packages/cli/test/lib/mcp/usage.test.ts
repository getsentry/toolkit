import { ALL_SKILLS } from "@sentry/mcp-core/skills";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../../../src/lib/constants.js";
import { parseMcpInvocation } from "../../../src/lib/mcp/server.js";
import { buildMcpUsage } from "../../../src/lib/mcp/usage.js";

describe("buildMcpUsage", () => {
  it("documents CLI session auth and the static token override", () => {
    const usage = buildMcpUsage(["inspect"]);

    expect(usage).toContain("Uses the active Sentry CLI session");
    expect(usage).toContain("sentry auth login");
    expect(usage).toContain("--access-token <token>");
    expect(usage).toContain("SENTRY_ACCESS_TOKEN");
    expect(usage).toContain("Available skills: inspect");
    expect(usage).not.toContain("device code");
    expect(usage).not.toContain("auth [login|logout|status]");
  });

  it("lists every server flag", () => {
    const usage = buildMcpUsage(ALL_SKILLS);
    for (const flag of [
      "--access-token",
      "--host",
      "--url",
      "--insecure-http",
      "--mcp-url",
      "--sentry-dsn",
      "--experimental",
      "--help",
      "--version",
      "--agent-provider",
      "--openai-base-url",
      "--openai-model",
      "--anthropic-base-url",
      "--anthropic-model",
      "--organization-slug",
      "--project-slug",
      "--skills",
      "--all-skills",
      "--disable-skills",
    ]) {
      expect(usage).toContain(flag);
    }
  });
});

describe("parseMcpInvocation", () => {
  it.each([["--help"], ["-h"]])("prints usage for %s", (flag) => {
    expect(parseMcpInvocation([flag], {})).toEqual({
      kind: "output",
      text: buildMcpUsage(ALL_SKILLS),
    });
  });

  it.each([["--version"], ["-v"]])("prints the CLI version for %s", (flag) => {
    expect(parseMcpInvocation([flag], {})).toEqual({
      kind: "output",
      text: `sentry mcp ${CLI_VERSION}`,
    });
  });

  it("prints help even when other arguments are invalid", () => {
    expect(parseMcpInvocation(["--bogus", "--help"], {}).kind).toBe("output");
  });

  it("builds a server config from flags and the environment", () => {
    const invocation = parseMcpInvocation(
      ["--host=sentry.example.com", "--skills=inspect"],
      { SENTRY_ACCESS_TOKEN: "envtok" },
    );
    expect(invocation).toMatchObject({
      kind: "serve",
      config: {
        accessToken: "envtok",
        sentryHost: "sentry.example.com",
        sentryProtocol: "https",
        finalSkills: new Set(["inspect"]),
      },
    });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseMcpInvocation(["--bogus"], {})).toThrow(
      "Invalid argument(s): --bogus",
    );
  });
});
