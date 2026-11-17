import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../src/lib/errors.js";
import {
  deprecatedFlags,
  mergeMcpArgs,
  parseMcpEnv,
  parseMcpTarget,
  splitInlineFlagValues,
} from "../../../src/lib/mcp/args.js";
import { parseMcpArgs, parseMcpFlags } from "./parse-flags.js";

describe("sentry mcp flags", () => {
  it("parses known flags", async () => {
    const parsed = await parseMcpFlags([
      "--access-token=tok",
      "--host=sentry.io",
      "--insecure-http",
      "--url=https://example.com",
      "--mcp-url=https://mcp.example.com",
      "--openai-base-url=https://api.example.com/v1",
      "--skills=inspect,triage",
      "--all-skills",
    ]);
    expect(parsed).toMatchObject({
      "access-token": "tok",
      host: "sentry.io",
      "insecure-http": true,
      url: "https://example.com",
      "mcp-url": "https://mcp.example.com",
      "openai-base-url": "https://api.example.com/v1",
      skills: "inspect,triage",
      "all-skills": true,
    });
  });

  it("defaults boolean flags to off", async () => {
    expect(await parseMcpFlags([])).toMatchObject({
      "insecure-http": false,
      "all-skills": false,
      experimental: false,
    });
  });

  it("parses --disable-skills", async () => {
    const parsed = await parseMcpFlags(["--disable-skills=seer"]);
    expect(parsed["disable-skills"]).toBe("seer");
  });

  it.each(["azure-openai", "openrouter"])(
    "parses --agent-provider=%s",
    async (provider) => {
      const parsed = await parseMcpFlags([`--agent-provider=${provider}`]);
      expect(parsed["agent-provider"]).toBe(provider);
    },
  );

  it("accepts empty and multi-line --flag=value forms", async () => {
    const flags = await parseMcpFlags(["--mcp-url=", "--access-token=a\nb"]);
    expect(flags["mcp-url"]).toBe("");
    expect(flags["access-token"]).toBe("a\nb");
  });

  it("rejects unknown flags and a second positional", async () => {
    await expect(parseMcpFlags(["--unknown"])).rejects.toThrow(/unknown/);
    // Removed: MCP telemetry always goes to the CLI's project.
    await expect(parseMcpFlags(["--sentry-dsn="])).rejects.toThrow(
      /sentry-dsn/,
    );
    await expect(parseMcpFlags(["acme/", "extra"])).rejects.toThrow(/extra/);
  });
});

describe("splitInlineFlagValues", () => {
  it("splits only the joined forms Stricli does not read", () => {
    expect(
      splitInlineFlagValues([
        "--mcp-url=",
        "--access-token=tok\n",
        "--host=sentry.io",
        "--all-skills",
        "x=",
      ]),
    ).toEqual([
      "--mcp-url",
      "",
      "--access-token",
      "tok\n",
      "--host=sentry.io",
      "--all-skills",
      "x=",
    ]);
  });
});

describe("parseMcpEnv", () => {
  it("parses environment variables including skills", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_URL: "envmcp",
      MCP_SKILLS: "inspect,triage",
    });
    expect(env.mcpUrl).toBe("envmcp");
    expect(env.skills).toBe("inspect,triage");
  });

  it("reads MCP_DISABLE_SKILLS", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_DISABLE_SKILLS: "seer",
    });
    expect(env.disableSkills).toBe("seer");
  });
});

describe("mergeMcpArgs", () => {
  it("applies precedence: flags over env", async () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_URL: "envmcp",
    });
    const flags = await parseMcpFlags([
      "--access-token=clitok",
      "--host=clihost",
      "--insecure-http",
      "--mcp-url=climcp",
      "--openai-base-url=https://api.cli/v1",
    ]);
    const merged = mergeMcpArgs(flags, env);
    expect(merged.host).toBe("clihost");
    expect(merged.insecureHttp).toBe(true);
    expect(merged.mcpUrl).toBe("climcp");
    expect(merged.openaiBaseUrl).toBe("https://api.cli/v1");
  });

  it("applies precedence for skills: flags over env", async () => {
    const env = parseMcpEnv({ MCP_SKILLS: "inspect" });
    const flags = await parseMcpFlags(["--skills=inspect,triage"]);
    expect(mergeMcpArgs(flags, env).skills).toBe("inspect,triage");
  });

  it("falls back to env when the skills flag is absent", async () => {
    const env = parseMcpEnv({ MCP_SKILLS: "inspect,triage" });
    expect(mergeMcpArgs(await parseMcpFlags([]), env).skills).toBe(
      "inspect,triage",
    );
  });

  it("lets --all-skills override env skills", async () => {
    const env = parseMcpEnv({ MCP_SKILLS: "inspect" });
    const merged = mergeMcpArgs(await parseMcpFlags(["--all-skills"]), env);
    expect(merged.allSkills).toBe(true);
    expect(merged.skills).toBeUndefined();
  });

  it("applies precedence for disableSkills: flags over env", async () => {
    const env = parseMcpEnv({ MCP_DISABLE_SKILLS: "docs" });
    const flags = await parseMcpFlags(["--disable-skills=seer"]);
    expect(mergeMcpArgs(flags, env).disableSkills).toBe("seer");
  });

  it("falls back to env when the disable-skills flag is absent", async () => {
    const env = parseMcpEnv({ MCP_DISABLE_SKILLS: "seer" });
    expect(mergeMcpArgs(await parseMcpFlags([]), env).disableSkills).toBe(
      "seer",
    );
  });

  it("applies precedence for agentProvider: flags over env", async () => {
    const env = parseMcpEnv({ EMBEDDED_AGENT_PROVIDER: "openai" });
    const flags = await parseMcpFlags(["--agent-provider=azure-openai"]);
    expect(mergeMcpArgs(flags, env).agentProvider).toBe("azure-openai");
  });
});

describe("@sentry/mcp-server flag parity", () => {
  it("accepts every flag the server has always taken", async () => {
    const flags = await parseMcpFlags([
      "--access-token=tok",
      "--host=sentry.example.com",
      "--insecure-http",
      "--url=https://sentry.example.com",
      "--mcp-url=https://mcp.example.com",
      "--openai-base-url=https://openai.example.com/v1",
      "--openai-model=gpt-test",
      "--anthropic-base-url=https://anthropic.example.com",
      "--anthropic-model=claude-test",
      "--agent-provider=anthropic",
      "--organization-slug=acme",
      "--project-slug=web",
      "--skills=inspect",
      "--all-skills",
      "--disable-skills=seer",
      "--experimental",
    ]);
    expect(mergeMcpArgs(flags, {})).toEqual({
      host: "sentry.example.com",
      insecureHttp: true,
      url: "https://sentry.example.com",
      mcpUrl: "https://mcp.example.com",
      openaiBaseUrl: "https://openai.example.com/v1",
      openaiModel: "gpt-test",
      anthropicBaseUrl: "https://anthropic.example.com",
      anthropicModel: "claude-test",
      agentProvider: "anthropic",
      agentProviderFromFlag: true,
      organizationSlug: "acme",
      projectSlug: "web",
      skills: "inspect",
      allSkills: true,
      disableSkills: "seer",
      experimental: true,
    });
  });

  it("accepts space-separated flag values", async () => {
    const flags = await parseMcpFlags([
      "--access-token",
      "tok",
      "--host",
      "h.test",
    ]);
    expect(flags["access-token"]).toBe("tok");
    expect(flags.host).toBe("h.test");
  });

  it("reads every server environment variable", () => {
    expect(
      parseMcpEnv({
        SENTRY_ACCESS_TOKEN: "envtok",
        MCP_URL: "https://mcp.example.com",
        OPENAI_MODEL: "gpt-test",
        ANTHROPIC_MODEL: "claude-test",
        EMBEDDED_AGENT_PROVIDER: "openrouter",
        MCP_SKILLS: "inspect",
        MCP_DISABLE_SKILLS: "seer",
      }),
    ).toEqual({
      mcpUrl: "https://mcp.example.com",
      openaiModel: "gpt-test",
      anthropicModel: "claude-test",
      agentProvider: "openrouter",
      skills: "inspect",
      disableSkills: "seer",
    });
  });

  // A server started from a project shell or IDE inherits the app's DSN.
  it("ignores SENTRY_DSN and DEFAULT_SENTRY_DSN", () => {
    expect(
      parseMcpEnv({ SENTRY_DSN: "app", DEFAULT_SENTRY_DSN: "default" }),
    ).toEqual({});
  });

  it("leaves the deprecated SENTRY_ACCESS_TOKEN to serveMcp", () => {
    expect(parseMcpEnv({ SENTRY_ACCESS_TOKEN: "envtok" })).toEqual({});
  });

  it("records whether the agent provider came from the flag", async () => {
    const env = parseMcpEnv({ EMBEDDED_AGENT_PROVIDER: "openai" });
    expect(
      mergeMcpArgs(await parseMcpFlags([]), env).agentProviderFromFlag,
    ).toBe(false);
    expect(
      mergeMcpArgs(await parseMcpFlags(["--agent-provider=openai"]), env)
        .agentProviderFromFlag,
    ).toBe(true);
  });
});

describe("sentry mcp scope flags", () => {
  it("takes the CLI's --org and --project", async () => {
    const flags = await parseMcpFlags(["--org=acme", "--project", "web"]);
    expect(mergeMcpArgs(flags, {})).toMatchObject({
      organizationSlug: "acme",
      projectSlug: "web",
    });
    expect(deprecatedFlags(flags)).toEqual([]);
  });

  it("keeps --organization-slug and --project-slug as deprecated aliases", async () => {
    const flags = await parseMcpFlags([
      "--organization-slug=acme",
      "--project-slug=web",
    ]);
    expect(mergeMcpArgs(flags, {})).toMatchObject({
      organizationSlug: "acme",
      projectSlug: "web",
    });
    expect(deprecatedFlags(flags)).toEqual([
      { flag: "organization-slug", replacement: "--org" },
      { flag: "project-slug", replacement: "--project" },
    ]);
  });

  it("accepts a new flag and its alias with the same value", async () => {
    const flags = await parseMcpFlags([
      "--org=acme",
      "--organization-slug=acme",
    ]);
    expect(mergeMcpArgs(flags, {}).organizationSlug).toBe("acme");
  });

  it("rejects a new flag and its alias with different values", async () => {
    const flags = await parseMcpFlags(["--project=web", "--project-slug=api"]);
    expect(() => mergeMcpArgs(flags, {})).toThrow(ValidationError);
  });
});

describe("sentry mcp <org>/<project> target", () => {
  it("scopes nothing without a target", async () => {
    const { flags, scope } = await parseMcpArgs([]);
    expect(scope).toBeUndefined();
    expect(mergeMcpArgs(flags, {}, scope)).toMatchObject({
      organizationSlug: undefined,
      projectSlug: undefined,
    });
  });

  it("reads <org>/ as an organization", async () => {
    const { flags, scope } = await parseMcpArgs(["acme/"]);
    expect(scope).toEqual({ org: "acme" });
    expect(mergeMcpArgs(flags, {}, scope)).toMatchObject({
      organizationSlug: "acme",
      projectSlug: undefined,
    });
  });

  it("reads <org>/<project> as an organization and project", async () => {
    const { flags, scope } = await parseMcpArgs(["acme/web", "--all-skills"]);
    expect(scope).toEqual({ org: "acme", project: "web" });
    expect(mergeMcpArgs(flags, {}, scope)).toMatchObject({
      organizationSlug: "acme",
      projectSlug: "web",
      allSkills: true,
    });
  });

  it("refuses a bare slug, pointing at <slug>/", () => {
    expect(() => parseMcpTarget("acme")).toThrow(ValidationError);
    expect(() => parseMcpTarget("acme")).toThrow("pass 'acme/'");
    expect(() => parseMcpTarget("acme")).toThrow("names no command");
    expect(() => parseMcpTarget("/web")).toThrow(/no organization/);
  });

  it("refuses a URL, pointing at SENTRY_URL", () => {
    for (const url of [
      "https://sentry.io/organizations/acme/projects/web/",
      "https://acme.sentry.io/issues/",
      "http://sentry.example.com/acme/",
    ]) {
      expect(() => parseMcpTarget(url)).toThrow(/SENTRY_URL/);
    }
  });

  it("refuses more than one project", () => {
    expect(() => parseMcpTarget("acme/web/api")).toThrow(ValidationError);
    expect(() => parseMcpTarget("acme/web,api")).toThrow(ValidationError);
  });

  it("refuses an invalid slug", () => {
    expect(() => parseMcpTarget("acme/web?x=1")).toThrow(ValidationError);
  });

  it("rejects a bad target at parse time", async () => {
    await expect(parseMcpArgs(["acme"])).rejects.toThrow(/acme\//);
  });

  it("combines <org>/ with --project", async () => {
    const { flags, scope } = await parseMcpArgs(["acme/", "--project=web"]);
    expect(mergeMcpArgs(flags, {}, scope)).toMatchObject({
      organizationSlug: "acme",
      projectSlug: "web",
    });
  });

  it("accepts flags that repeat the target", async () => {
    const { flags, scope } = await parseMcpArgs([
      "acme/web",
      "--org=acme",
      "--project-slug=web",
    ]);
    expect(mergeMcpArgs(flags, {}, scope)).toMatchObject({
      organizationSlug: "acme",
      projectSlug: "web",
    });
  });

  it("rejects flags that conflict with the target", async () => {
    for (const args of [
      ["acme/", "--org=other"],
      ["acme/web", "--project=api"],
      ["acme/", "--organization-slug=other"],
    ]) {
      const { flags, scope } = await parseMcpArgs(args);
      expect(() => mergeMcpArgs(flags, {}, scope)).toThrow(ValidationError);
    }
  });
});

describe("sentry mcp target flags", () => {
  it("keeps --host, --url, and --insecure-http as deprecated aliases", async () => {
    const flags = await parseMcpFlags([
      "--host=sentry.example.com",
      "--insecure-http",
      "--url=https://sentry.example.com",
    ]);
    expect(mergeMcpArgs(flags, {})).toMatchObject({
      host: "sentry.example.com",
      insecureHttp: true,
      url: "https://sentry.example.com",
    });
    expect(deprecatedFlags(flags)).toEqual([
      { flag: "host", replacement: "SENTRY_HOST" },
      { flag: "url", replacement: "SENTRY_URL" },
      { flag: "insecure-http", replacement: "an http:// SENTRY_URL" },
    ]);
  });

  it("reports nothing without the deprecated flags", async () => {
    expect(deprecatedFlags(await parseMcpFlags([]))).toEqual([]);
  });
});
