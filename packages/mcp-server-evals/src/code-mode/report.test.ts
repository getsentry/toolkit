import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { writeEvalReport } from "./report";

test("a multi-task suite and its control preserve every report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-mode-reports-"));
  try {
    const reports = [];
    for (const task of [
      "dashboard",
      "release",
      "repositories",
      "alert",
      "monitor",
      "release-recovery",
      "repositories-retry",
      "repositories-denied",
    ]) {
      for (const surface of ["catalog-and-code", "catalog"]) {
        const report = {
          task,
          surface,
          successes: surface === "catalog" ? 0 : 3,
        };
        const file = await writeEvalReport(
          { root, task, client: "claude", surface },
          report,
        );
        reports.push({ file, report });
      }
    }
    expect(new Set(reports.map(({ file }) => file)).size).toBe(16);
    for (const { file, report } of reports) {
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(report);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
