/**
 * Tests for snapshot image collection + validation.
 *
 * Real PNG fixtures are generated in-memory with pngjs (no committed binaries)
 * so the header parser reads genuine headers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, test } from "vitest";
import { ValidationError } from "../../../src/lib/errors.js";
import {
  type CollectedImage,
  collectImages,
  MAX_PIXELS_PER_IMAGE,
  normalizeImageNames,
  splitAndTrim,
  validateImageSizes,
} from "../../../src/lib/snapshots/images.js";

/** Encode a solid PNG of the given dimensions. */
function pngBytes(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0xff);
  return PNG.sync.write(png);
}

const dirs: string[] = [];
function tempTree(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "snap-img-"));
  dirs.push(root);
  build(root);
  return root;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

describe("collectImages", () => {
  test("collects PNGs with dimensions, hash, and sidecar; skips hidden + non-images", async () => {
    const root = tempTree((r) => {
      writeFileSync(join(r, "a.png"), pngBytes(4, 3));
      writeFileSync(join(r, "a.json"), JSON.stringify({ custom: "value" }));
      mkdirSync(join(r, "sub"));
      writeFileSync(join(r, "sub", "b.png"), pngBytes(2, 2));
      writeFileSync(join(r, "notes.txt"), "not an image");
      writeFileSync(join(r, ".hidden.png"), pngBytes(1, 1));
    });

    const images = await collectImages(root);
    const byKey = new Map(images.map((i) => [i.relativePath, i]));

    expect([...byKey.keys()].sort()).toEqual(["a.png", "sub/b.png"]);
    const a = byKey.get("a.png");
    expect(a?.width).toBe(4);
    expect(a?.height).toBe(3);
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.sidecar).toEqual({ custom: "value" });
    // No sidecar for sub/b.png → empty object.
    expect(byKey.get("sub/b.png")?.sidecar).toEqual({});
  });

  test("returns an empty list for a directory with no images", async () => {
    const root = tempTree((r) => {
      writeFileSync(join(r, "readme.md"), "hi");
    });
    expect(await collectImages(root)).toEqual([]);
  });

  test("skips malformed and unsupported image content without decoding it", async () => {
    const root = tempTree((r) => {
      writeFileSync(join(r, "malformed.png"), Buffer.from("not a PNG"));
      writeFileSync(join(r, "unsupported.jpg"), Buffer.from("not a JPEG"));
      writeFileSync(join(r, "jxl.png"), Buffer.from([0xff, 0x0a, 0x00, 0x00]));
    });

    await expect(collectImages(root)).resolves.toEqual([]);
  });
});

describe("validateImageSizes", () => {
  function img(width: number, height: number): CollectedImage {
    return {
      path: "/x.png",
      relativePath: "x.png",
      width,
      height,
      hash: "h",
      sidecar: {},
    };
  }

  test("passes at the pixel limit", () => {
    expect(() => validateImageSizes([img(8000, 5000)])).not.toThrow(); // 40,000,000
  });

  test("throws listing images over the pixel limit", () => {
    expect(() => validateImageSizes([img(8001, 5000)])).toThrow(
      ValidationError
    );
    expect(() => validateImageSizes([img(8001, 5000)])).toThrow(
      String(MAX_PIXELS_PER_IMAGE)
    );
  });
});

describe("splitAndTrim", () => {
  test("splits on a comma, trimming and dropping empties", () => {
    expect(splitAndTrim("a.png, b.png ,  , c.png", ",")).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
  });

  test("splits on newlines", () => {
    expect(splitAndTrim("a.png\nb.png\n\nc.png\n", "\n")).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
  });
});

describe("normalizeImageNames", () => {
  test("strips a leading ./ and backslashes → forward slashes", () => {
    expect(normalizeImageNames(["./img/a.png", "img\\b.png", "c.png"])).toEqual(
      ["img/a.png", "img/b.png", "c.png"]
    );
  });
});
