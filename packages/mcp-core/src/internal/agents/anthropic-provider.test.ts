import type { LanguageModelV3 } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAnthropicModel,
  setAnthropicBaseUrl,
} from "./anthropic-provider.js";

describe("anthropic-provider", () => {
  const originalModel = process.env.ANTHROPIC_MODEL;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    setAnthropicBaseUrl(undefined);
    delete process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalModel === undefined) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = originalModel;
    }

    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  it("defaults to a model that is not scheduled for retirement", () => {
    const model = getAnthropicModel() as LanguageModelV3;

    // Anthropic retires claude-sonnet-4-5 on 2026-11-30.
    expect(model.modelId).toBe("claude-sonnet-5-5");
  });
});
