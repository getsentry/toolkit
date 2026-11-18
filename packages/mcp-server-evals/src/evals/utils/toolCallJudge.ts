import {
  createJudge,
  ToolCallJudge as BaseToolCallJudge,
  type Judge,
  type JudgeContext,
  type ToolCallJudgeConfig,
} from "vitest-evals";
import type { EvalCase } from "./harness";

/** Checks the run's tool calls against the eval case's `expectedTools`. */
export function ToolCallJudge(
  config: ToolCallJudgeConfig = {},
): Judge<JudgeContext<EvalCase, string>> {
  const judge = BaseToolCallJudge(config);
  return createJudge<JudgeContext<EvalCase, string>>("ToolCallJudge", (ctx) =>
    judge.assess({
      ...ctx,
      input: ctx.input.input,
      expectedTools: ctx.input.expectedTools,
    }),
  );
}
