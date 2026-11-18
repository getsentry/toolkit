import { describe, expect, test } from "vitest";
import {
  type BenchResult,
  comparePaired,
  comparisonSection,
  verdict,
} from "../../script/lib/docs-agent-report.js";

function run(task: string, arm: string, costUsd: number): BenchResult {
  return {
    agent: "claude",
    task,
    arm,
    passed: true,
    seconds: 10,
    inputTokens: 1000,
    outputTokens: 100,
    costUsd,
    docsSteps: [{ bytes: 2000 }],
  };
}

describe("comparePaired", () => {
  test("a change on every task is clear", () => {
    const comparison = comparePaired([
      [1, 0.5],
      [2, 1.1],
      [4, 1.9],
      [3, 1.4],
    ]);
    expect(comparison?.change).toBeCloseTo(-0.5, 1);
    expect(comparison?.lower).toBe(4);
    expect(comparison && verdict(comparison)).toBe("lower");
  });

  test("changes in both directions are not clear", () => {
    const comparison = comparePaired([
      [1, 2],
      [2, 1],
      [1, 1.5],
      [1.5, 1],
    ]);
    expect(comparison && verdict(comparison)).toBe("no clear difference");
  });

  test("skips tasks that miss a side", () => {
    expect(comparePaired([[0, 1]])).toBeUndefined();
    expect(
      comparePaired([
        [1, 2],
        [0, 1],
      ])?.tasks,
    ).toBe(1);
  });
});

describe("comparisonSection", () => {
  test("compares each CLI version with the web arm", () => {
    const section = comparisonSection("claude sonnet", [
      run("a", "web", 0.1),
      run("b", "web", 0.2),
      { ...run("a", "cli", 0.05), cli: "0.49.0" },
      { ...run("b", "cli", 0.1), cli: "0.49.0" },
    ]);
    expect(section).toContain("| web | cli 0.49.0 |");
    expect(section).toContain(
      "| mean cost per run | $0.150 | $0.075 | -50% | -50% to -50% | 2/2 tasks | lower |",
    );
  });

  test("needs two arms", () => {
    expect(comparisonSection("x", [run("a", "web", 0.1)])).toContain(
      "Needs runs of the `web` arm",
    );
  });
});
