import { streamText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setServerVersion } from "../../version";
import {
  getAgentProvider,
  setAgentProvider,
  setProviderBaseUrls,
} from "./provider-factory";
import type { AgentProviderType } from "./types";

const API_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"];

// Direct streamText callers, such as the chat playground, get no call-level
// User-Agent, so each provider has to send its own.
describe("provider User-Agent on direct streamText calls", () => {
  afterEach(() => {
    setAgentProvider(undefined);
    setProviderBaseUrls({});
    setServerVersion(undefined);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each<{
    name: string;
    provider: AgentProviderType;
    apiKey: string;
    openaiBaseUrl?: string;
    anthropicBaseUrl?: string;
  }>([
    {
      name: "openai",
      provider: "openai",
      apiKey: "OPENAI_API_KEY",
      openaiBaseUrl: "https://llm.test/v1",
    },
    {
      name: "anthropic",
      provider: "anthropic",
      apiKey: "ANTHROPIC_API_KEY",
      anthropicBaseUrl: "https://llm.test/v1",
    },
    {
      name: "openrouter",
      provider: "openrouter",
      apiKey: "OPENROUTER_API_KEY",
    },
    {
      name: "azure-openai v1",
      provider: "azure-openai",
      apiKey: "OPENAI_API_KEY",
      openaiBaseUrl: "https://example.openai.azure.com/openai/v1",
    },
    {
      name: "azure-openai deployment",
      provider: "azure-openai",
      apiKey: "OPENAI_API_KEY",
      openaiBaseUrl:
        "https://example.openai.azure.com/openai/deployments/gpt-5",
    },
  ])("$name", async ({ provider, apiKey, openaiBaseUrl, anthropicBaseUrl }) => {
    for (const key of API_KEYS) {
      vi.stubEnv(key, key === apiKey ? "test-key" : "");
    }
    setAgentProvider(provider);
    setProviderBaseUrls({ openaiBaseUrl, anthropicBaseUrl });
    setServerVersion("1.2.3-x");

    const userAgents: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
        userAgents.push(new Request(input, init).headers.get("user-agent"));
        return new Response("{}", { status: 400 });
      }),
    );

    await streamText({
      model: getAgentProvider().getModel(),
      prompt: "hello",
      onError: () => {},
    }).consumeStream();

    expect(userAgents).toHaveLength(1);
    const [userAgent] = userAgents;
    expect(userAgent).toMatch(
      /^sentry-mcp\/1\.2\.3-x \(https:\/\/mcp\.sentry\.dev\) /,
    );
    expect(userAgent?.match(/sentry-mcp\//g)).toHaveLength(1);
  });
});
