import { describe, expect, test } from "vitest";
import { createNativeModelFallbacks, PRIMARY_MODEL } from "./model-fallback";

describe("createNativeModelFallbacks", () => {
  test("tries Kimi after the primary and standard fallback models", () => {
    const result = createNativeModelFallbacks(PRIMARY_MODEL, "sk-or-test");

    expect(
      result.map((entry) => ({ id: entry.id, model: entry.model.modelId })),
    ).toEqual([
      { id: "openrouter-primary", model: "anthropic/claude-sonnet-4.6" },
      { id: "openrouter-fallback", model: "openai/gpt-5.4" },
      { id: "openrouter-kimi-fallback", model: "moonshotai/kimi-k2.5" },
    ]);
  });
});
