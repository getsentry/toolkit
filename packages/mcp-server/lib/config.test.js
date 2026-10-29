import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UsageError, isHostedSentryHost, resolveConfig } from "./config.js";

const TOKEN = ["--access-token=TOKEN"];

/**
 * @param {string[]} argv
 * @param {Record<string, string>} [env]
 */
function endpointFor(argv, env = {}) {
  const config = resolveConfig([...TOKEN, ...argv], env);
  assert.equal(config.kind, "run");
  return config.endpoint.href;
}

/**
 * @param {string[]} argv
 * @param {RegExp} message
 * @param {Record<string, string>} [env]
 */
function assertUsageError(argv, message, env = {}) {
  assert.throws(
    () => resolveConfig(argv, env),
    (error) => error instanceof UsageError && message.test(error.message),
  );
}

describe("resolveConfig", () => {
  it("targets the hosted MCP with the token from the flag or the environment", () => {
    const fromFlag = resolveConfig(TOKEN, { SENTRY_ACCESS_TOKEN: "ENV" });
    assert.equal(fromFlag.kind, "run");
    assert.equal(fromFlag.accessToken, "TOKEN");
    assert.equal(fromFlag.endpoint.href, "https://mcp.sentry.dev/mcp");
    assert.deepEqual(fromFlag.warnings, []);

    const fromEnv = resolveConfig([], { SENTRY_ACCESS_TOKEN: "ENV" });
    assert.equal(fromEnv.kind, "run");
    assert.equal(fromEnv.accessToken, "ENV");
  });

  it("maps constraints to path segments", () => {
    assert.equal(
      endpointFor(["--organization-slug=acme"]),
      "https://mcp.sentry.dev/mcp/acme",
    );
    assert.equal(
      endpointFor(["--organization-slug", "acme", "--project-slug", "web"]),
      "https://mcp.sentry.dev/mcp/acme/web",
    );
    assertUsageError(
      [...TOKEN, "--project-slug=web"],
      /--project-slug requires --organization-slug/,
    );
  });

  it("maps skills and experimental mode to query parameters", () => {
    assert.equal(
      endpointFor(["--skills=inspect, triage", "--disable-skills=seer"]),
      "https://mcp.sentry.dev/mcp?skills=inspect%2Ctriage&disable-skills=seer",
    );
    assert.equal(
      endpointFor(["--experimental"]),
      "https://mcp.sentry.dev/mcp?experimental=1",
    );
    assert.equal(
      endpointFor([], { MCP_SKILLS: "inspect", MCP_DISABLE_SKILLS: "docs" }),
      "https://mcp.sentry.dev/mcp?skills=inspect&disable-skills=docs",
    );
  });

  it("keeps the old skill precedence", () => {
    assert.equal(
      endpointFor(["--skills=triage"], { MCP_SKILLS: "inspect" }),
      "https://mcp.sentry.dev/mcp?skills=triage",
    );
    // --all-skills is the hosted default, and it overrides MCP_SKILLS.
    assert.equal(
      endpointFor(["--all-skills"], { MCP_SKILLS: "inspect" }),
      "https://mcp.sentry.dev/mcp",
    );
    assertUsageError(
      [...TOKEN, "--all-skills", "--skills=inspect"],
      /cannot be combined/,
    );
    assertUsageError([...TOKEN, "--skills=,"], /at least one skill/);
  });

  it("accepts an MCP origin override for local testing", () => {
    assert.equal(
      endpointFor(["--mcp-url=http://localhost:8788", "--organization-slug=a"]),
      "http://localhost:8788/mcp/a",
    );
    assert.equal(
      endpointFor([], { MCP_URL: "https://mcp.example.dev/mcp" }),
      "https://mcp.example.dev/mcp",
    );
    assertUsageError(
      [...TOKEN, "--mcp-url=http://mcp.example.dev"],
      /must use https/,
    );
    assertUsageError([...TOKEN, "--mcp-url=nope"], /Invalid MCP URL/);
  });

  it("accepts sentry.io hosts, including regions", () => {
    for (const host of ["sentry.io", "us.sentry.io", "de.sentry.io"]) {
      assert.equal(
        endpointFor([`--host=${host}`]),
        "https://mcp.sentry.dev/mcp",
      );
    }
    assert.equal(
      endpointFor([], { SENTRY_URL: "https://de.sentry.io/" }),
      "https://mcp.sentry.dev/mcp",
    );
  });

  it("rejects self-hosted Sentry and points to `sentry mcp`", () => {
    const selfHosted = /cannot reach sentry\.example\.com.*npx -y sentry mcp/;
    assertUsageError([...TOKEN, "--host=sentry.example.com"], selfHosted);
    assertUsageError(
      [...TOKEN, "--url=https://sentry.example.com"],
      selfHosted,
    );
    assertUsageError(TOKEN, selfHosted, { SENTRY_HOST: "sentry.example.com" });
    assertUsageError(TOKEN, selfHosted, {
      SENTRY_URL: "https://sentry.example.com",
    });
    assertUsageError(
      [...TOKEN, "--url=http://sentry.io"],
      /cannot reach http:\/\/sentry\.io/,
    );
    assertUsageError(
      [...TOKEN, "--insecure-http"],
      /--insecure-http only applies to self-hosted.*npx -y sentry mcp/,
    );
  });

  it("explains how to get a token when none is set", () => {
    assertUsageError(
      [],
      /No Sentry access token[\s\S]*SENTRY_ACCESS_TOKEN[\s\S]*npx -y sentry mcp/,
    );
    assertUsageError(["--access-token=  "], /No Sentry access token/);
  });

  it("points the old auth commands to the CLI", () => {
    for (const argv of [["auth"], ["auth", "login"], ["auth", "status"]]) {
      assertUsageError(argv, /npx -y sentry auth login/);
    }
  });

  it("rejects local embedded agent flags", () => {
    for (const flag of [
      "--agent-provider=anthropic",
      "--openai-base-url=https://example.openai.azure.com/openai/v1/",
      "--openai-model=gpt-5",
      "--anthropic-base-url=https://example.com",
      "--anthropic-model=claude",
    ]) {
      assertUsageError([...TOKEN, flag], /own embedded agent.*sentry mcp/);
    }
  });

  it("warns about settings the hosted MCP ignores", () => {
    const config = resolveConfig(
      [...TOKEN, "--sentry-dsn=https://k@o.ingest"],
      {
        OPENAI_API_KEY: "sk",
        EMBEDDED_AGENT_PROVIDER: "openai",
      },
    );
    assert.equal(config.kind, "run");
    assert.equal(config.warnings.length, 2);
    assert.match(config.warnings[0], /--sentry-dsn is ignored/);
    assert.match(
      config.warnings[1],
      /Ignoring EMBEDDED_AGENT_PROVIDER, OPENAI_API_KEY/,
    );
  });

  it("rejects unknown arguments and missing values", () => {
    assertUsageError([...TOKEN, "--nope"], /Invalid argument\(s\): --nope/);
    assertUsageError([...TOKEN, "extra"], /Invalid argument\(s\): extra/);
    assertUsageError([...TOKEN, "--host"], /--host requires a value/);
  });

  it("handles --help and --version before validation", () => {
    assert.deepEqual(resolveConfig(["--help"], {}), { kind: "help" });
    assert.deepEqual(resolveConfig(["-v", "--host=sentry.example.com"], {}), {
      kind: "version",
    });
  });
});

describe("isHostedSentryHost", () => {
  it("matches sentry.io and its subdomains only", () => {
    assert.equal(isHostedSentryHost("sentry.io"), true);
    assert.equal(isHostedSentryHost("US.sentry.io"), true);
    assert.equal(isHostedSentryHost("acme.sentry.io"), true);
    assert.equal(isHostedSentryHost("notsentry.io"), false);
    assert.equal(isHostedSentryHost("sentry.io.example.com"), false);
    assert.equal(isHostedSentryHost("sentry.io:8080"), false);
  });
});
