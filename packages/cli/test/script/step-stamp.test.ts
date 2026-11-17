import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runUnlessUnchanged } from "../../script/lib/step-stamp.js";

const files = { inputs: ["input.txt"], outputs: ["output.txt"] };

describe("runUnlessUnchanged", () => {
  const originalCwd = process.cwd();
  let dir: string;
  let runs: number;

  /** A step that copies its input to its output, counting its runs. */
  async function run(): Promise<void> {
    await runUnlessUnchanged("copy", files, async () => {
      runs += 1;
      writeFileSync("output.txt", `copy of ${runs}`);
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-step-stamp-"));
    process.chdir(dir);
    writeFileSync("input.txt", "v1");
    runs = 0;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("skips a step whose inputs and outputs are unchanged", async () => {
    await run();
    await run();
    expect(runs).toBe(1);
  });

  test("ignores modification times", async () => {
    await run();
    const later = new Date(Date.now() + 60_000);
    utimesSync("input.txt", later, later);
    utimesSync("output.txt", later, later);
    await run();
    expect(runs).toBe(1);
  });

  test("reruns when an input changes", async () => {
    await run();
    writeFileSync("input.txt", "v2");
    await run();
    expect(runs).toBe(2);
  });

  test("reruns when an output was rewritten or removed", async () => {
    await run();
    writeFileSync("output.txt", "edited");
    await run();
    expect(runs).toBe(2);

    rmSync("output.txt");
    await run();
    expect(runs).toBe(3);
  });

  test("reruns when the stamps are cleaned", async () => {
    await run();
    rmSync("src/generated", { recursive: true });
    await run();
    expect(runs).toBe(2);
  });

  test("always runs when an input is missing", async () => {
    rmSync("input.txt");
    await run();
    await run();
    expect(runs).toBe(2);
  });
});
