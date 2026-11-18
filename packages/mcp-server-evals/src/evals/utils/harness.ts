import {
  attachHarnessRunToError,
  createFailedHarnessRun,
  createHarness,
  toJsonValue,
  type EvalTestAPI,
  type Harness,
  type JsonValue,
  type TranscriptEvent,
} from "vitest-evals";

export type ExpectedToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

/**
 * One eval scenario. The task only sees `input`; judges read the expectations
 * from the case, because suite-level judges receive the harness input.
 */
export type EvalCase = {
  input: string;
  name?: string;
  expectedTools?: ExpectedToolCall[];
  expected?: Record<string, unknown>;
};

type EvalTaskResult = {
  result: string;
  toolCalls?: Array<{ name: string; arguments?: unknown }>;
};

type EvalTaskRunner = (input: string) => Promise<EvalTaskResult>;

type EvalHarness = Harness<EvalCase, string>;

function toJsonObject(value: unknown): Record<string, JsonValue> | undefined {
  const normalized = toJsonValue(value);
  return normalized &&
    typeof normalized === "object" &&
    !Array.isArray(normalized)
    ? normalized
    : undefined;
}

/** Adapts a task runner into a harness with a normalized transcript. */
export function createTaskHarness(
  name: string,
  task: EvalTaskRunner,
): EvalHarness {
  return createHarness<EvalCase, string>({
    name,
    run: async ({ input: { input } }) => {
      let result: EvalTaskResult;
      try {
        result = await task(input);
      } catch (error) {
        // Record the prompt, not the whole case with its expectations.
        throw attachHarnessRunToError(
          error,
          createFailedHarnessRun(input, error),
        );
      }

      const events: TranscriptEvent[] = [
        { type: "message", role: "user", content: input },
        ...(result.toolCalls ?? []).map((call, index): TranscriptEvent => {
          const args = toJsonObject(call.arguments);
          return {
            type: "tool_call",
            id: `tool-${index}`,
            name: call.name,
            ...(args ? { arguments: args } : {}),
          };
        }),
        { type: "message", role: "assistant", content: result.result },
      ];

      return { output: result.result, events };
    },
  });
}

/** Registers one test per case; each runs the suite harness and judges once. */
export function defineEvalCases(
  it: EvalTestAPI<EvalCase, string, EvalHarness>,
  cases: EvalCase[],
  { timeout = 60000 }: { timeout?: number } = {},
) {
  for (const testCase of cases) {
    it(testCase.name ?? testCase.input, { timeout }, async ({ run }) => {
      await run(testCase);
    });
  }
}
