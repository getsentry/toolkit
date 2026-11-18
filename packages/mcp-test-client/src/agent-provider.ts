export type TestClientAgentProvider = "openai" | "openrouter";

/**
 * Resolves the test-client LLM provider from environment configuration.
 */
export function resolveAgentProvider(
  env: NodeJS.ProcessEnv,
): TestClientAgentProvider | undefined {
  const configuredProvider = env["EMBEDDED_AGENT_PROVIDER"]?.toLowerCase();
  if (configuredProvider === "openai" && env["OPENAI_API_KEY"]) {
    return configuredProvider;
  }
  if (configuredProvider === "openrouter" && env["OPENROUTER_API_KEY"]) {
    return configuredProvider;
  }
  if (configuredProvider) {
    return undefined;
  }

  const providerKeys = [
    env["ANTHROPIC_API_KEY"],
    env["OPENAI_API_KEY"],
    env["OPENROUTER_API_KEY"],
  ].filter(Boolean);
  if (providerKeys.length > 1) return undefined;
  if (env["OPENAI_API_KEY"]) return "openai";
  if (env["OPENROUTER_API_KEY"]) return "openrouter";
  return undefined;
}
