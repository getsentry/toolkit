#!/usr/bin/env node

// Pre-commit generated-output dispatcher. It runs before lint-staged, owns
// staging generated artifacts for staged generator inputs, refuses partially
// staged inputs, and only stages generated outputs that were clean beforehand.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const GENERATED_TASKS = [
  {
    name: "MCP tool and skill definitions",
    command: ["pnpm", "--filter", "@sentry/mcp-core", "generate-definitions"],
    inputs: [
      /^packages\/mcp-core\/src\/tools\/(?!.*\.test\.ts$).*\.ts$/,
      /^packages\/mcp-core\/src\/skills\.ts$/,
      /^packages\/mcp-core\/src\/internal\/tool-helpers\/tool-call-formatting\.ts$/,
      /^packages\/mcp-core\/scripts\/generate-definitions\.ts$/,
      /^plugins\/sentry-mcp\/agents\/sentry-mcp\.md$/,
      /^plugins\/sentry-mcp-experimental\/agents\/sentry-mcp\.md$/,
    ],
    outputs: [
      "packages/mcp-core/src/toolDefinitions.json",
      "packages/mcp-core/src/skillDefinitions.json",
      "plugins/sentry-mcp/agents/sentry-mcp.md",
      "plugins/sentry-mcp-experimental/agents/sentry-mcp.md",
    ],
  },
];

function run(command) {
  execFileSync(command[0], command.slice(1), {
    stdio: "inherit",
  });
}

function getStagedFiles() {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMRD"],
    { encoding: "utf8" },
  );

  return output.split("\n").filter(Boolean);
}

function hasWorkingTreeChanges(path) {
  try {
    execFileSync("git", ["diff", "--quiet", path], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
}

function getDirtyFiles(files) {
  return files.filter(
    (file) => existsSync(file) && hasWorkingTreeChanges(file),
  );
}

const stagedFiles = getStagedFiles();

if (stagedFiles.length === 0) {
  process.exit(0);
}

let ranTask = false;

for (const task of GENERATED_TASKS) {
  const stagedInputs = stagedFiles.filter((file) =>
    task.inputs.some((pattern) => pattern.test(file)),
  );

  if (stagedInputs.length === 0) {
    continue;
  }

  const dirtyStagedInputs = getDirtyFiles(stagedInputs);
  if (dirtyStagedInputs.length > 0) {
    console.error(
      [
        `Cannot generate ${task.name} with unstaged changes in staged inputs:`,
        ...dirtyStagedInputs.map((file) => `  - ${file}`),
        "Stage or discard those changes before committing.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`Generating ${task.name}...`);
  const dirtyOutputsBeforeGeneration = getDirtyFiles(task.outputs);
  if (dirtyOutputsBeforeGeneration.length > 0) {
    console.error(
      [
        `Cannot generate ${task.name} with unstaged changes in generated outputs:`,
        ...dirtyOutputsBeforeGeneration.map((file) => `  - ${file}`),
        "Stage or discard those changes before committing.",
      ].join("\n"),
    );
    process.exit(1);
  }

  run(task.command);

  // Only stage outputs that exist on disk, were clean before generation, and
  // currently differ from the index.
  // Skipping missing files avoids a crash when an output is staged for deletion
  // (e.g. via git rm) and the generator does not recreate it. Skipping
  // previously dirty files avoids staging unrelated working-tree edits.
  const outputsToStage = task.outputs.filter((output) => {
    if (!existsSync(output)) return false;
    return hasWorkingTreeChanges(output);
  });
  if (outputsToStage.length > 0) {
    run(["git", "add", ...outputsToStage]);
  }
  ranTask = true;
}

if (!ranTask) {
  console.log("No generated files need updating for staged changes.");
}
