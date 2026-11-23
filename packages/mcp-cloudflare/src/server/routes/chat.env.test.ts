import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncOpenRouterEnvFromBindings } from "./chat";

describe("syncOpenRouterEnvFromBindings", () => {
  const originalApiKey = process.env["OPENROUTER_API_KEY"];
  const originalModel = process.env["OPENROUTER_MODEL"];
  const originalEffort = process.env["OPENROUTER_REASONING_EFFORT"];

  beforeEach(() => {
    delete process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_MODEL"];
    delete process.env["OPENROUTER_REASONING_EFFORT"];
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env["OPENROUTER_API_KEY"];
    } else {
      process.env["OPENROUTER_API_KEY"] = originalApiKey;
    }

    if (originalModel === undefined) {
      delete process.env["OPENROUTER_MODEL"];
    } else {
      process.env["OPENROUTER_MODEL"] = originalModel;
    }

    if (originalEffort === undefined) {
      delete process.env["OPENROUTER_REASONING_EFFORT"];
    } else {
      process.env["OPENROUTER_REASONING_EFFORT"] = originalEffort;
    }
  });

  it("returns false when neither binding nor process.env has a key", () => {
    expect(syncOpenRouterEnvFromBindings({})).toBe(false);
    expect(process.env["OPENROUTER_API_KEY"]).toBeUndefined();
  });

  it("copies worker bindings into process.env for provider helpers", () => {
    expect(
      syncOpenRouterEnvFromBindings({
        OPENROUTER_API_KEY: "from-binding",
        OPENROUTER_MODEL: "openai/gpt-5.6-luna",
        OPENROUTER_REASONING_EFFORT: "high",
      }),
    ).toBe(true);

    expect(process.env["OPENROUTER_API_KEY"]).toBe("from-binding");
    expect(process.env["OPENROUTER_MODEL"]).toBe("openai/gpt-5.6-luna");
    expect(process.env["OPENROUTER_REASONING_EFFORT"]).toBe("high");
  });

  it("falls back to process.env when the binding is missing", () => {
    process.env["OPENROUTER_API_KEY"] = "from-process";

    expect(syncOpenRouterEnvFromBindings({})).toBe(true);
    expect(process.env["OPENROUTER_API_KEY"]).toBe("from-process");
  });

  it("prefers the worker binding over an existing process.env key", () => {
    process.env["OPENROUTER_API_KEY"] = "from-process";

    expect(
      syncOpenRouterEnvFromBindings({
        OPENROUTER_API_KEY: "from-binding",
      }),
    ).toBe(true);

    expect(process.env["OPENROUTER_API_KEY"]).toBe("from-binding");
  });

  it("clears stale model and effort when bindings are removed", () => {
    process.env["OPENROUTER_API_KEY"] = "from-process";
    process.env["OPENROUTER_MODEL"] = "stale-model";
    process.env["OPENROUTER_REASONING_EFFORT"] = "stale-effort";

    expect(
      syncOpenRouterEnvFromBindings({
        OPENROUTER_API_KEY: "from-binding",
      }),
    ).toBe(true);

    expect(process.env["OPENROUTER_API_KEY"]).toBe("from-binding");
    expect(process.env["OPENROUTER_MODEL"]).toBeUndefined();
    expect(process.env["OPENROUTER_REASONING_EFFORT"]).toBeUndefined();
  });

  it("preserves empty-string reasoning effort as omit-provider-option", () => {
    expect(
      syncOpenRouterEnvFromBindings({
        OPENROUTER_API_KEY: "from-binding",
        OPENROUTER_REASONING_EFFORT: "",
      }),
    ).toBe(true);

    expect(process.env["OPENROUTER_REASONING_EFFORT"]).toBe("");
  });
});
