/**
 * sentry snapshots diff <base-dir> <head-dir>
 *
 * Compare two directories of snapshot images locally. Images present in both
 * are diffed perceptually (pure-JS pixelmatch, equivalent to the legacy CLI's
 * odiff); byte-identical pairs short-circuit. Emits a JSON report and writes a
 * PNG diff mask per changed image.
 *
 * Local-only — no API calls.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { ValidationError } from "../../lib/errors.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  categorizeImages,
  collectImageFiles,
  compareImages,
  type DiffOptions,
} from "../../lib/snapshots/diff.js";

const DEFAULT_OUTPUT = "./diff-output/";

/** Per-image comparison status. */
type ImageStatus =
  | "unchanged"
  | "changed"
  | "layout_changed"
  | "added"
  | "removed"
  | "skipped"
  | "error";

/** Result for a single image. */
type ImageResult = {
  name: string;
  status: ImageStatus;
  /** Percentage of differing pixels (0–100); set only for `changed`. */
  diffPercentage?: number;
  diffPixelCount?: number;
  diffMaskPath?: string;
  error?: string;
};

/** Aggregate counts across all images. */
type DiffSummary = {
  total: number;
  changed: number;
  unchanged: number;
  added: number;
  removed: number;
  skipped: number;
  errored: number;
};

/** Structured result for `snapshots diff`. */
type DiffReport = {
  baseDir: string;
  headDir: string;
  outputDir: string;
  threshold: number;
  summary: DiffSummary;
  images: ImageResult[];
};

/** Flags accepted by `snapshots diff`. */
type DiffFlags = {
  output?: string;
  threshold?: number;
  "no-antialiasing"?: boolean;
  "fail-on-diff"?: boolean;
  selective?: boolean;
};

/** Parse `--threshold` as a float in [0, 1]. */
function parseThreshold(value: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("threshold must be a number between 0.0 and 1.0");
  }
  return parsed;
}

/** Extract a message from a thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Assert a path is an existing directory. */
function assertDirectory(path: string, label: string): void {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    if (statSync(path).isDirectory()) {
      return;
    }
  } catch {
    // Fall through to the error below.
  }
  throw new ValidationError(
    `${label} directory does not exist: ${path}`,
    "dir"
  );
}

/**
 * The diff mask path for an image (always a PNG). PNG sources keep their name;
 * non-PNG sources append `.png` (e.g. `a.jpg` → `a.jpg.png`) so a `.png` and a
 * `.jpg` with the same stem don't collide on the same mask file.
 */
function diffMaskRelPath(rel: string): string {
  return extname(rel).toLowerCase() === ".png" ? rel : `${rel}.png`;
}

/** The base/head/output directories for a diff run. */
type DiffDirs = { baseDir: string; headDir: string; outputDir: string };

/** Compare a single matched image, writing its diff mask when changed. */
function compareMatched(
  dirs: DiffDirs,
  rel: string,
  opts: DiffOptions
): ImageResult {
  let baseBuf: Buffer;
  let headBuf: Buffer;
  try {
    baseBuf = readFileSync(join(dirs.baseDir, rel));
    headBuf = readFileSync(join(dirs.headDir, rel));
  } catch (err) {
    return { name: rel, status: "error", error: errorMessage(err) };
  }

  // Fast path: byte-identical files can't differ visually.
  if (baseBuf.equals(headBuf)) {
    return { name: rel, status: "unchanged" };
  }

  let result: ReturnType<typeof compareImages>;
  try {
    result = compareImages(baseBuf, headBuf, rel, opts);
  } catch (err) {
    return { name: rel, status: "error", error: errorMessage(err) };
  }

  if (result.kind === "match") {
    return { name: rel, status: "unchanged" };
  }
  if (result.kind === "layout") {
    return { name: rel, status: "layout_changed" };
  }

  const maskPath = join(dirs.outputDir, diffMaskRelPath(rel));
  try {
    mkdirSync(dirname(maskPath), { recursive: true });
    writeFileSync(maskPath, result.mask);
  } catch (err) {
    return { name: rel, status: "error", error: errorMessage(err) };
  }
  return {
    name: rel,
    status: "changed",
    diffPercentage: result.diffPercentage,
    diffPixelCount: result.diffCount,
    diffMaskPath: maskPath,
  };
}

/** Build the aggregate summary from per-image results. */
function summarize(images: ImageResult[]): DiffSummary {
  const count = (...statuses: ImageStatus[]) =>
    images.filter((img) => statuses.includes(img.status)).length;
  return {
    total: images.length,
    changed: count("changed", "layout_changed"),
    unchanged: count("unchanged"),
    added: count("added"),
    removed: count("removed"),
    skipped: count("skipped"),
    errored: count("error"),
  };
}

/** Short per-image detail for the human summary (diff %, error, or blank). */
function notableDetail(img: ImageResult): string {
  if (img.status === "changed" && img.diffPercentage !== undefined) {
    return `${img.diffPercentage.toFixed(2)}%`;
  }
  if (img.error) {
    return colorTag("red", img.error);
  }
  return "";
}

/** Human-readable formatter: a summary table plus notable per-image rows. */
function formatDiffReport(data: DiffReport): string {
  const { summary } = data;
  const table = mdKvTable([
    ["Total", String(summary.total)],
    ["Changed", String(summary.changed)],
    ["Unchanged", String(summary.unchanged)],
    ["Added", String(summary.added)],
    ["Removed", String(summary.removed)],
    ["Skipped", String(summary.skipped)],
    ["Errored", String(summary.errored)],
  ]);

  const notable = data.images.filter((img) => img.status !== "unchanged");
  if (notable.length === 0) {
    return renderMarkdown(table);
  }
  const rows = notable.map((img): [string, string] => [
    img.name,
    `${img.status} ${notableDetail(img)}`.trim(),
  ]);
  return renderMarkdown(`${table}\n\n${mdKvTable(rows)}`);
}

export const diffCommand = buildCommand({
  // Local-only: reads two image directories, no network access.
  auth: false,
  docs: {
    brief: "Compare two directories of snapshot images",
    fullDescription:
      "Compare two directories of snapshot images locally. Images present in " +
      "both directories are diffed perceptually; a PNG diff mask is written " +
      "for each changed image, and a JSON report is printed.\n\n" +
      "Comparison is anti-aliasing aware (disable with --no-antialiasing) and " +
      "makes no network requests.\n\n" +
      "Usage:\n" +
      "  sentry snapshots diff ./baseline ./head\n" +
      "  sentry snapshots diff ./baseline ./head --threshold 0.02 --output ./diffs/\n" +
      "  sentry snapshots diff ./baseline ./head --fail-on-diff",
  },
  output: {
    human: formatDiffReport,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Path to the baseline image directory",
          parse: String,
          placeholder: "base-dir",
        },
        {
          brief: "Path to the head image directory",
          parse: String,
          placeholder: "head-dir",
        },
      ],
    },
    flags: {
      output: {
        kind: "parsed",
        parse: String,
        brief: `Directory for diff mask images (default: ${DEFAULT_OUTPUT})`,
        optional: true,
      },
      threshold: {
        kind: "parsed",
        parse: parseThreshold,
        brief: "Pixel color difference threshold (0.0-1.0)",
        default: "0.01",
      },
      "no-antialiasing": {
        kind: "boolean",
        brief: "Disable antialiasing detection",
        optional: true,
      },
      "fail-on-diff": {
        kind: "boolean",
        brief:
          "Exit non-zero if any diffs (changed/added/removed/errored) are found",
        optional: true,
      },
      selective: {
        kind: "boolean",
        brief: "Treat images missing from head as skipped instead of removed",
        optional: true,
      },
    },
    aliases: {
      o: "output",
    },
  },
  async *func(
    this: SentryContext,
    flags: DiffFlags,
    baseDirArg: string,
    headDirArg: string
  ) {
    const baseDir = resolve(this.cwd, baseDirArg);
    const headDir = resolve(this.cwd, headDirArg);
    assertDirectory(baseDir, "Base");
    assertDirectory(headDir, "Head");

    const outputDir = resolve(this.cwd, flags.output ?? DEFAULT_OUTPUT);
    const opts: DiffOptions = {
      threshold: flags.threshold ?? 0.01,
      antialiasing: !flags["no-antialiasing"],
    };

    const [baseFiles, headFiles] = await Promise.all([
      collectImageFiles(baseDir),
      collectImageFiles(headDir),
    ]);
    const categorized = categorizeImages(
      baseFiles,
      headFiles,
      Boolean(flags.selective)
    );

    const dirs: DiffDirs = { baseDir, headDir, outputDir };
    const images: ImageResult[] = [];
    for (const rel of categorized.matched) {
      images.push(compareMatched(dirs, rel, opts));
    }
    for (const rel of categorized.added) {
      images.push({ name: rel, status: "added" });
    }
    for (const rel of categorized.removed) {
      images.push({ name: rel, status: "removed" });
    }
    for (const rel of categorized.skipped) {
      images.push({ name: rel, status: "skipped" });
    }

    const summary = summarize(images);
    yield new CommandOutput<DiffReport>({
      baseDir,
      headDir,
      outputDir,
      threshold: opts.threshold,
      summary,
      images,
    });

    // Masks are written only for pixel-`changed` images — not layout_changed,
    // added, or removed — so only claim mask output when some were written.
    const masksWritten = images.some((img) => img.diffMaskPath !== undefined);
    const maskNote = masksWritten ? ` Diff masks written to ${outputDir}.` : "";

    const failures =
      summary.changed + summary.added + summary.removed + summary.errored;
    if (flags["fail-on-diff"] && failures > 0) {
      this.process.exitCode = 1;
      return {
        hint: `${failures} image(s) differed from baseline.${maskNote}`,
      };
    }
    return {
      hint:
        failures > 0
          ? `${failures} image(s) differed from baseline.${maskNote}`
          : "No changes detected.",
    };
  },
});
