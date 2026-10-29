import { describe, expect, it } from "vitest";
import {
  mergeMcpArgs,
  parseMcpArgv,
  parseMcpEnv,
} from "../../../src/lib/mcp/args.js";

describe("parseMcpArgv", () => {
  it("parses known flags and short aliases", () => {
    const parsed = parseMcpArgv([
      "--access-token=tok",
      "--host=sentry.io",
      "--insecure-http",
      "--url=https://example.com",
      "--mcp-url=https://mcp.example.com",
      "--sentry-dsn=dsn",
      "--openai-base-url=https://api.example.com/v1",
      "--skills=inspect,triage",
      "--all-skills",
      "-h",
      "-v",
    ]);
    expect(parsed.accessToken).toBe("tok");
    expect(parsed.host).toBe("sentry.io");
    expect(parsed.insecureHttp).toBe(true);
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.mcpUrl).toBe("https://mcp.example.com");
    expect(parsed.sentryDsn).toBe("dsn");
    expect(parsed.openaiBaseUrl).toBe("https://api.example.com/v1");
    expect(parsed.skills).toBe("inspect,triage");
    expect(parsed.allSkills).toBe(true);
    expect(parsed.help).toBe(true);
    expect(parsed.version).toBe(true);
    expect(parsed.unknownArgs).toEqual([]);
  });

  it("parses skills flags", () => {
    const parsed = parseMcpArgv([
      "--access-token=tok",
      "--skills=inspect,triage",
    ]);
    expect(parsed.accessToken).toBe("tok");
    expect(parsed.skills).toBe("inspect,triage");
  });

  it("parses --disable-skills", () => {
    const parsed = parseMcpArgv([
      "--access-token=tok",
      "--disable-skills=seer",
    ]);
    expect(parsed.disableSkills).toBe("seer");
  });

  it("parses --all-skills", () => {
    const parsed = parseMcpArgv(["--access-token=tok", "--all-skills"]);
    expect(parsed.accessToken).toBe("tok");
    expect(parsed.allSkills).toBe(true);
  });

  it("parses --insecure-http", () => {
    const parsed = parseMcpArgv([
      "--access-token=tok",
      "--host=sentry.internal:9000",
      "--insecure-http",
    ]);
    expect(parsed.host).toBe("sentry.internal:9000");
    expect(parsed.insecureHttp).toBe(true);
  });

  it("parses --agent-provider=azure-openai", () => {
    const parsed = parseMcpArgv([
      "--access-token=tok",
      "--agent-provider=azure-openai",
    ]);
    expect(parsed.agentProvider).toBe("azure-openai");
  });

  it("parses --agent-provider=openrouter", () => {
    const parsed = parseMcpArgv([
      "--access-token=tok",
      "--agent-provider=openrouter",
    ]);
    expect(parsed.agentProvider).toBe("openrouter");
  });

  it("collects unknown args", () => {
    const parsed = parseMcpArgv(["--unknown", "--another=1"]);
    expect(parsed.unknownArgs.length).toBeGreaterThan(0);
  });
});

describe("parseMcpEnv", () => {
  it("parses environment variables including skills", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_URL: "envmcp",
      SENTRY_DSN: "envdsn",
      MCP_SKILLS: "inspect,triage",
    });
    expect(env.accessToken).toBe("envtok");
    expect(env.mcpUrl).toBe("envmcp");
    expect(env.sentryDsn).toBe("envdsn");
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
  it("applies precedence: CLI over env", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_URL: "envmcp",
      SENTRY_DSN: "envdsn",
    });
    const cli = parseMcpArgv([
      "--access-token=clitok",
      "--host=clihost",
      "--insecure-http",
      "--mcp-url=climcp",
      "--sentry-dsn=clidsn",
      "--openai-base-url=https://api.cli/v1",
    ]);
    const merged = mergeMcpArgs(cli, env);
    expect(merged.accessToken).toBe("clitok");
    expect(merged.host).toBe("clihost");
    expect(merged.insecureHttp).toBe(true);
    expect(merged.mcpUrl).toBe("climcp");
    expect(merged.sentryDsn).toBe("clidsn");
    expect(merged.openaiBaseUrl).toBe("https://api.cli/v1");
  });

  it("applies precedence for skills: CLI over env", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_SKILLS: "inspect",
    });
    const cli = parseMcpArgv([
      "--access-token=clitok",
      "--skills=inspect,triage",
    ]);
    const merged = mergeMcpArgs(cli, env);
    expect(merged.skills).toBe("inspect,triage");
  });

  it("falls back to env when CLI skills not provided", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_SKILLS: "inspect,triage",
    });
    const cli = parseMcpArgv(["--access-token=clitok"]);
    const merged = mergeMcpArgs(cli, env);
    expect(merged.skills).toBe("inspect,triage");
  });

  it("lets CLI allSkills override env skills", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_SKILLS: "inspect",
    });
    const cli = parseMcpArgv(["--access-token=clitok", "--all-skills"]);
    const merged = mergeMcpArgs(cli, env);
    expect(merged.allSkills).toBe(true);
    expect(merged.skills).toBeUndefined();
  });

  it("applies precedence for disableSkills: CLI over env", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_DISABLE_SKILLS: "docs",
    });
    const cli = parseMcpArgv([
      "--access-token=clitok",
      "--disable-skills=seer",
    ]);
    const merged = mergeMcpArgs(cli, env);
    expect(merged.disableSkills).toBe("seer");
  });

  it("falls back to env when CLI disableSkills not provided", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      MCP_DISABLE_SKILLS: "seer",
    });
    const cli = parseMcpArgv(["--access-token=clitok"]);
    const merged = mergeMcpArgs(cli, env);
    expect(merged.disableSkills).toBe("seer");
  });

  it("applies precedence for agentProvider: CLI over env", () => {
    const env = parseMcpEnv({
      SENTRY_ACCESS_TOKEN: "envtok",
      EMBEDDED_AGENT_PROVIDER: "openai",
    });
    const cli = parseMcpArgv([
      "--access-token=clitok",
      "--agent-provider=azure-openai",
    ]);
    const merged = mergeMcpArgs(cli, env);
    expect(merged.agentProvider).toBe("azure-openai");
  });
});

describe("@sentry/mcp-server flag parity", () => {
  it("accepts every standalone server flag", () => {
    const parsed = parseMcpArgv([
      "--access-token=tok",
      "--host=sentry.example.com",
      "--insecure-http",
      "--url=https://sentry.example.com",
      "--mcp-url=https://mcp.example.com",
      "--sentry-dsn=dsn",
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
      "--help",
      "--version",
    ]);
    expect(parsed).toEqual({
      accessToken: "tok",
      host: "sentry.example.com",
      insecureHttp: true,
      url: "https://sentry.example.com",
      mcpUrl: "https://mcp.example.com",
      sentryDsn: "dsn",
      openaiBaseUrl: "https://openai.example.com/v1",
      openaiModel: "gpt-test",
      anthropicBaseUrl: "https://anthropic.example.com",
      anthropicModel: "claude-test",
      agentProvider: "anthropic",
      organizationSlug: "acme",
      projectSlug: "web",
      skills: "inspect",
      allSkills: true,
      disableSkills: "seer",
      experimental: true,
      help: true,
      version: true,
      unknownArgs: [],
    });
  });

  it("accepts space-separated flag values", () => {
    const parsed = parseMcpArgv(["--access-token", "tok", "--host", "h.test"]);
    expect(parsed.accessToken).toBe("tok");
    expect(parsed.host).toBe("h.test");
  });

  it("reports unknown flags and positionals by their raw spelling", () => {
    expect(parseMcpArgv(["--bogus=1", "-x", "extra"]).unknownArgs).toEqual([
      "--bogus",
      "-x",
      "extra",
    ]);
  });

  it("reads every standalone server environment variable", () => {
    expect(
      parseMcpEnv({
        SENTRY_ACCESS_TOKEN: "envtok",
        MCP_URL: "https://mcp.example.com",
        SENTRY_DSN: "dsn",
        OPENAI_MODEL: "gpt-test",
        ANTHROPIC_MODEL: "claude-test",
        EMBEDDED_AGENT_PROVIDER: "openrouter",
        MCP_SKILLS: "inspect",
        MCP_DISABLE_SKILLS: "seer",
      }),
    ).toEqual({
      accessToken: "envtok",
      mcpUrl: "https://mcp.example.com",
      sentryDsn: "dsn",
      openaiModel: "gpt-test",
      anthropicModel: "claude-test",
      agentProvider: "openrouter",
      skills: "inspect",
      disableSkills: "seer",
    });
  });

  it("falls back to DEFAULT_SENTRY_DSN for telemetry", () => {
    expect(parseMcpEnv({ DEFAULT_SENTRY_DSN: "default" }).sentryDsn).toBe(
      "default",
    );
  });

  it("uses SENTRY_ACCESS_TOKEN when --access-token is absent", () => {
    const merged = mergeMcpArgs(
      parseMcpArgv([]),
      parseMcpEnv({ SENTRY_ACCESS_TOKEN: "envtok" }),
    );
    expect(merged.accessToken).toBe("envtok");
  });

  it("records whether the agent provider came from the flag", () => {
    const env = parseMcpEnv({ EMBEDDED_AGENT_PROVIDER: "openai" });
    expect(mergeMcpArgs(parseMcpArgv([]), env).agentProviderFromFlag).toBe(
      false,
    );
    expect(
      mergeMcpArgs(parseMcpArgv(["--agent-provider=openai"]), env)
        .agentProviderFromFlag,
    ).toBe(true);
  });
});
