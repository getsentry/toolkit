import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { hasSuccessfulSearchValidation } from "../../tools/support/search-events/agent";
import { callEmbeddedAgent } from "./callEmbeddedAgent";
import { getAgentProvider } from "./provider-factory";

vi.mock("./provider-factory", () => ({ getAgentProvider: vi.fn() }));
vi.mock("../../telem/logging", () => ({
  logIssue: vi.fn(),
  logWarn: vi.fn(),
}));

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function setupAgent(
  validationPassesOnLastStep: boolean,
  finalStepValidationCount = 1,
) {
  let callCount = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const step = ++callCount;
      if (step <= 5) {
        return {
          content: Array.from(
            { length: step === 5 ? finalStepValidationCount : 1 },
            (_, candidate) => ({
              type: "tool-call" as const,
              toolCallId: `validation-${step}-${candidate}`,
              toolName: "validateSearch",
              input: JSON.stringify({ step, candidate }),
            }),
          ),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: '{"result":"ready"}' }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  vi.mocked(getAgentProvider).mockReturnValue({
    type: "openai",
    label: "mock",
    getModel: () => model,
    getProviderOptions: () => ({}),
  });

  const validateSearch = tool({
    inputSchema: z.object({ step: z.number(), candidate: z.number() }),
    execute: async ({ step }) => ({
      result: { valid: validationPassesOnLastStep && step === 5 },
    }),
  });

  return { model, validateSearch };
}

it("returns a structured answer after three validations pass on the fifth step", async () => {
  const { model, validateSearch } = setupAgent(true, 3);

  const result = await callEmbeddedAgent({
    system: "Translate the query",
    prompt: "Test query",
    tools: { validateSearch },
    schema: z.object({ result: z.string() }),
    isReadyToFinalize: ({ toolResults }) =>
      hasSuccessfulSearchValidation(toolResults),
  });

  expect(result.result).toEqual({ result: "ready" });
  expect(result.toolCalls).toHaveLength(7);
  expect(model.doGenerateCalls).toHaveLength(6);
  expect(model.doGenerateCalls[5]?.toolChoice).toEqual({ type: "none" });
});

it("stops after five steps when the final validation fails", async () => {
  const { model, validateSearch } = setupAgent(false);

  await expect(
    callEmbeddedAgent({
      system: "Translate the query",
      prompt: "Test query",
      tools: { validateSearch },
      schema: z.object({ result: z.string() }),
      isReadyToFinalize: ({ toolResults }) =>
        hasSuccessfulSearchValidation(toolResults),
    }),
  ).rejects.toThrow("could not construct a valid query");

  expect(model.doGenerateCalls).toHaveLength(5);
});
