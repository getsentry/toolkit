/**
 * Simple terminal output logger for the MCP client.
 *
 * In an ideal world, this would use a state manager to track the last active logger,
 * and it'd accept streams to the log functions. It'd then handle automatically
 * terminating a previous block, inserting a new block, and restarting the previous
 * block when streams receive new data. This is just a simplified version as this is
 * not a big concern in this project.
 */

import chalk from "chalk";

let responseStarted = false;

export const logError = (msg: string, detail?: unknown) =>
  process.stdout.write(
    `\n${chalk.red("●")} ${msg}${detail ? `\n  ⎿  ${chalk.gray(detail instanceof Error ? detail.message : detail)}` : ""}\n`,
  );

export const logSuccess = (msg: string, detail?: string) =>
  process.stdout.write(
    `\n${chalk.green("●")} ${msg}${detail ? `\n  ⎿  ${chalk.gray(detail)}` : ""}\n`,
  );

export const logInfo = (msg: string, detail?: string) =>
  process.stdout.write(
    `\n${chalk.blue("●")} ${msg}${detail ? `\n  ⎿  ${chalk.gray(detail)}` : ""}\n`,
  );

export const logUser = (msg: string) =>
  process.stdout.write(`\n${chalk.gray(">")} ${chalk.gray(msg)}\n`);

export const logTool = (name: string, args?: unknown) => {
  const params =
    typeof args === "object" && args !== null && Object.keys(args).length > 0
      ? `(${Object.entries(args)
          .map(
            ([k, v]) =>
              `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
          )
          .join(", ")})`
      : "()";
  process.stdout.write(`\n${chalk.green("●")} ${name}${params}\n`);
};

export const logToolResult = (msg: string) =>
  process.stdout.write(`  ⎿  ${chalk.white(msg)}\n`);

export const logStreamStart = () => {
  if (!responseStarted) {
    process.stdout.write(`\n${chalk.white("●")} `);
    responseStarted = true;
  }
};

export const logStreamWrite = (chunk: string) =>
  process.stdout.write(chunk.replace(/\n/g, "\n  "));

export const logStreamEnd = () => {
  if (responseStarted) {
    process.stdout.write("\n");
    responseStarted = false;
  }
};
