import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Keep each task and tool surface's evidence in its own report. */
export async function writeEvalReport(
  destination: {
    root: string;
    task: string;
    client: string;
    surface: string;
    reportPath?: string;
  },
  report: unknown,
) {
  const reportPath = path.resolve(
    destination.reportPath ??
      path.join(
        destination.root,
        `.cache/code-mode/http-${destination.task}-${destination.client}-${destination.surface}.json`,
      ),
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}
