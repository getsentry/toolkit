/**
 * A no-op task runner that doesn't execute tools, just returns the input
 * for use with ToolPredictionJudge. This allows tests to focus on predicting
 * which tools would be called without actually executing them.
 */
export function NoOpTaskRunner() {
  return async function NoOpTaskRunner(input: string) {
    // Just return the input as the result, no tool execution
    return {
      result: input,
      toolCalls: [],
    };
  };
}
