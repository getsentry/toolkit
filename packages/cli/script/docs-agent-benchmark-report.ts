#!/usr/bin/env tsx
/**
 * Compare saved runs of the `sentry docs` agent benchmark.
 *
 * Reads the `--json` files of `docs-agent-benchmark.ts` and prints one
 * Markdown section per agent and model: each metric without and with
 * `sentry docs`, the paired change, its 90% interval, and a verdict. Runs
 * of the same model from several files are compared together, so a `web`
 * file and a `cli` file can be merged.
 *
 * Usage:
 *   pnpm run bench:docs-agent-report -- opus.json sonnet.json
 *   pnpm run bench:docs-agent-report -- "Opus 5.5=opus.json" web.json
 *
 * A `label=file` argument names that file's runs; files from before the
 * benchmark recorded the model need one.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  type BenchResult,
  comparisonSection,
} from "./lib/docs-agent-report.js";

const files = process.argv.slice(2).filter((arg) => arg !== "--");
if (files.length === 0) {
  throw new Error("Pass one or more --json files of the docs agent benchmark.");
}

const groups = new Map<string, BenchResult[]>();
for (const arg of files) {
  const split = arg.indexOf("=");
  const path = split > 0 ? arg.slice(split + 1) : arg;
  const label = split > 0 ? arg.slice(0, split) : undefined;
  const { results } = JSON.parse(readFileSync(path, "utf8")) as {
    results: BenchResult[];
  };
  for (const result of results) {
    const key =
      label ??
      (result.model
        ? `${result.agent} ${result.model}`
        : basename(path, ".json"));
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
}

process.stdout.write(
  [...groups]
    .map(([label, results]) => comparisonSection(label, results))
    .join("\n"),
);
