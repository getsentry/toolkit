/**
 * Drop node:sqlite's "SQLite is an experimental feature" warning. Import this
 * module first in each entry point, before anything loads node:sqlite.
 */

const originalEmit = process.emit.bind(process) as typeof process.emit;
process.emit = ((event: string, ...args: unknown[]) => {
  if (
    event === "warning" &&
    args[0] instanceof Error &&
    args[0].name === "ExperimentalWarning" &&
    args[0].message.includes("SQLite")
  ) {
    return false;
  }
  // @ts-expect-error: forwarding args to original emit
  return originalEmit(event, ...args);
}) as typeof process.emit;
