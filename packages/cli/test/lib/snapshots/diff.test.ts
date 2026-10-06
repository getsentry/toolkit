/**
 * Tests for local snapshot image diffing (pixelmatch + pngjs).
 *
 * Fixtures are generated in-memory with pngjs — no committed binaries.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { afterEach, describe, expect, test } from "vitest";
import {
  categorizeImages,
  collectImageFiles,
  compareImages,
} from "../../../src/lib/snapshots/diff.js";

/** Build a solid-color PNG of the given size. */
function png(
  width: number,
  height: number,
  rgb: [number, number, number]
): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    image.data[i] = rgb[0];
    image.data[i + 1] = rgb[1];
    image.data[i + 2] = rgb[2];
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

/** Build a solid-color JPEG (RGBA in, JPEG out). */
function jpeg(
  width: number,
  height: number,
  rgb: [number, number, number]
): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
    data[i + 3] = 255;
  }
  return Buffer.from(encodeJpeg({ data, width, height }, 100).data);
}

const OPTS = { threshold: 0.1, antialiasing: true };

describe("compareImages", () => {
  test("identical pixels → match", () => {
    const result = compareImages(
      png(4, 4, [10, 20, 30]),
      png(4, 4, [10, 20, 30]),
      "a.png",
      OPTS
    );
    expect(result.kind).toBe("match");
  });

  test("differing pixels → changed with a mask", () => {
    const result = compareImages(
      png(4, 4, [255, 0, 0]),
      png(4, 4, [0, 255, 0]),
      "a.png",
      OPTS
    );
    expect(result.kind).toBe("changed");
    if (result.kind === "changed") {
      expect(result.diffCount).toBe(16);
      // Percentage (0–100), matching legacy odiff output — all 16 px differ.
      expect(result.diffPercentage).toBe(100);
      expect(result.mask.length).toBeGreaterThan(0);
    }
  });

  test("mismatched dimensions → layout", () => {
    const result = compareImages(
      png(4, 4, [0, 0, 0]),
      png(8, 8, [0, 0, 0]),
      "a.png",
      OPTS
    );
    expect(result.kind).toBe("layout");
  });

  test("decodes JPEG inputs (identical → match)", () => {
    const result = compareImages(
      jpeg(4, 4, [20, 40, 60]),
      jpeg(4, 4, [20, 40, 60]),
      "a.jpg",
      OPTS
    );
    expect(result.kind).toBe("match");
  });

  test("throws on undecodable image data", () => {
    expect(() =>
      compareImages(
        Buffer.from("not a real png"),
        png(4, 4, [0, 0, 0]),
        "a.png",
        OPTS
      )
    ).toThrow();
  });
});

describe("categorizeImages", () => {
  test("partitions matched/added/removed", () => {
    expect(categorizeImages(["a", "b"], ["b", "c"], false)).toEqual({
      matched: ["b"],
      added: ["c"],
      removed: ["a"],
      skipped: [],
    });
  });

  test("selective treats base-only images as skipped", () => {
    expect(categorizeImages(["a", "b"], ["b", "c"], true)).toEqual({
      matched: ["b"],
      added: ["c"],
      removed: [],
      skipped: ["a"],
    });
  });
});

describe("collectImageFiles", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("collects images recursively and skips non-images", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-collect-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.png"), png(2, 2, [0, 0, 0]));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.png"), png(2, 2, [0, 0, 0]));
    writeFileSync(join(dir, "notes.txt"), "not an image");

    await expect(collectImageFiles(dir)).resolves.toEqual([
      "a.png",
      "sub/b.png",
    ]);
  });
});
