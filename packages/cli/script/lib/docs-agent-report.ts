/**
 * Compare the arms of the `sentry docs` agent benchmark.
 *
 * Each task runs in every arm, so the comparison is paired by task: for each
 * task, the `cli` arm's median is divided by the `web` arm's median, and the
 * change is the geometric mean of those ratios. A bootstrap over tasks gives
 * a 90% interval. When the interval is all below or all above zero, the
 * difference is clear; otherwise the task-to-task noise is larger than the
 * difference.
 */

/** One agent run, as `docs-agent-benchmark.ts` writes it with `--json`. */
export type BenchResult = {
  readonly agent: string;
  readonly model?: string;
  readonly cli?: string;
  readonly task: string;
  readonly arm: string;
  readonly passed: boolean;
  readonly seconds: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly docsSteps: readonly { readonly bytes?: number }[];
};

/** Change from the `web` arm to another arm across paired tasks. */
export type Comparison = {
  readonly tasks: number;
  readonly change: number;
  readonly low: number;
  readonly high: number;
  /** Tasks where the other arm's median is below the `web` arm's. */
  readonly lower: number;
};

type Metric = {
  readonly label: string;
  readonly value: (result: BenchResult) => number | undefined;
  /** Mean for totals that add up across runs, such as cost; else median. */
  readonly mean?: boolean;
  readonly format: (value: number) => string;
};

const BOOTSTRAP_SAMPLES = 2000;

function kilo(value: number): string {
  return `${(value / 1000).toFixed(1)}k`;
}

/** Bytes of docs text that reached the agent; undefined for runs from before it was recorded. */
function docsBytes(result: BenchResult): number | undefined {
  if (result.docsSteps.some((step) => step.bytes === undefined)) {
    return;
  }
  return result.docsSteps.reduce((sum, step) => sum + (step.bytes ?? 0), 0);
}

const METRICS: readonly Metric[] = [
  {
    label: "cost per run",
    value: (result) => result.costUsd || undefined,
    mean: true,
    format: (value) => `$${value.toFixed(3)}`,
  },
  {
    label: "time",
    value: (result) => result.seconds,
    format: (value) => `${value.toFixed(0)}s`,
  },
  {
    label: "input tokens",
    value: (result) => result.inputTokens || undefined,
    format: kilo,
  },
  {
    label: "output tokens",
    value: (result) => result.outputTokens || undefined,
    format: kilo,
  },
  {
    label: "docs read",
    value: docsBytes,
    format: (value) => `${(value / 1000).toFixed(1)} KB`,
  },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** A seeded generator, so the same results always print the same interval. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Compare per-task values of two arms: [web, other] for each task.
 * Pairs with a zero or missing side are skipped.
 */
export function comparePaired(
  pairs: readonly (readonly [number, number])[],
): Comparison | undefined {
  const logs = pairs
    .filter(([web, other]) => web > 0 && other > 0)
    .map(([web, other]) => Math.log(other / web));
  if (logs.length === 0) {
    return;
  }
  const next = random(1);
  const means = Array.from({ length: BOOTSTRAP_SAMPLES }, () =>
    mean(logs.map(() => logs[Math.floor(next() * logs.length)] ?? 0)),
  ).sort((a, b) => a - b);
  const at = (share: number) =>
    Math.exp(means[Math.floor(share * (means.length - 1))] ?? 0) - 1;
  return {
    tasks: logs.length,
    change: Math.exp(mean(logs)) - 1,
    low: at(0.05),
    high: at(0.95),
    lower: logs.filter((log) => log < 0).length,
  };
}

/** "lower", "higher", or "no clear difference" for the other arm. */
export function verdict(comparison: Comparison): string {
  if (comparison.high < 0) {
    return "lower";
  }
  if (comparison.low > 0) {
    return "higher";
  }
  return "no clear difference";
}

function percent(value: number): string {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** The arm with the CLI version, so runs of different CLIs stay apart. */
function armOf(result: BenchResult): string {
  return result.arm === "cli" && result.cli ? `cli ${result.cli}` : result.arm;
}

function aggregate(
  metric: Metric,
  results: readonly BenchResult[],
): number | undefined {
  const values = results.flatMap((result) => metric.value(result) ?? []);
  if (values.length === 0) {
    return;
  }
  return metric.mean ? mean(values) : median(values);
}

/** Paired comparison of one metric between the `web` arm and `other`. */
function compareMetric(
  metric: Metric,
  results: readonly BenchResult[],
  other: string,
): Comparison | undefined {
  const tasks = [...new Set(results.map((result) => result.task))];
  return comparePaired(
    tasks.map((task) => {
      const ofArm = (arm: string) =>
        aggregate(
          metric,
          results.filter((r) => r.task === task && armOf(r) === arm),
        ) ?? 0;
      return [ofArm("web"), ofArm(other)] as const;
    }),
  );
}

function passCell(results: readonly BenchResult[]): string {
  return `${results.filter((result) => result.passed).length}/${results.length}`;
}

/**
 * Markdown for one agent and model: each metric in the `web` arm and in
 * every other arm, with the paired change, its interval, and the verdict.
 */
export function comparisonSection(
  title: string,
  results: readonly BenchResult[],
): string {
  const others = [...new Set(results.map(armOf))].filter((a) => a !== "web");
  const web = results.filter((result) => armOf(result) === "web");
  const lines = [`### ${title}`, ""];
  if (web.length === 0 || others.length === 0) {
    lines.push("Needs runs of the `web` arm and another arm to compare.", "");
    return lines.join("\n");
  }
  for (const other of others) {
    const ofOther = results.filter((result) => armOf(result) === other);
    lines.push(
      `| without → with \`sentry docs\` (${other}) | web | ${other} | change | 90% interval | ${other} lower on | verdict |`,
      "| --- | --- | --- | --- | --- | --- | --- |",
      `| passed | ${passCell(web)} | ${passCell(ofOther)} | | | | |`,
    );
    for (const metric of METRICS) {
      const before = aggregate(metric, web);
      const after = aggregate(metric, ofOther);
      const comparison = compareMetric(metric, results, other);
      if (before === undefined || after === undefined || !comparison) {
        continue;
      }
      lines.push(
        `| ${metric.mean ? "mean " : "median "}${metric.label} | ${metric.format(before)} | ${metric.format(after)} | ${percent(comparison.change)} | ${percent(comparison.low)} to ${percent(comparison.high)} | ${comparison.lower}/${comparison.tasks} tasks | ${verdict(comparison)} |`,
      );
    }
    lines.push("");
  }
  if (results.some((result) => result.agent === "codex")) {
    lines.push(
      "Codex web search runs on OpenAI's side, so for Codex, docs read counts only text that came back from commands.",
      "",
    );
  }
  return lines.join("\n");
}
