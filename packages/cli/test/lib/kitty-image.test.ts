/**
 * Runtime image → kitty graphics encoder tests.
 *
 * Exercises the shape of the emitted kitty escape sequence (APC introducer,
 * RGBA format keys, base64 payload, chunking) and the decode-then-encode
 * convenience wrapper. Real terminal I/O is not involved — everything here is
 * pure and deterministic.
 */

import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import {
  encodeImageToKitty,
  imageBytesToKitty,
} from "../../src/lib/kitty-image.js";
import type { DecodedImage } from "../../src/lib/sixel-image.js";

const ESC = "\x1b";

/** Build a solid-color RGBA image of the given size. */
function solidImage(
  width: number,
  height: number,
  rgba: [number, number, number, number]
): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

/** Encode an RGBA DecodedImage as PNG bytes. */
function toPngBytes(img: DecodedImage): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  return new Uint8Array(PNG.sync.write(png));
}

describe("encodeImageToKitty", () => {
  test("emits an APC graphics sequence with RGBA format and dimensions", () => {
    const out = encodeImageToKitty(solidImage(2, 2, [255, 0, 0, 255]));
    expect(out).toBeDefined();
    const s = out as string;
    // APC introducer ... String Terminator.
    expect(s.startsWith(`${ESC}_G`)).toBe(true);
    expect(s.endsWith(`${ESC}\\`)).toBe(true);
    // Transmit+display, 32-bit RGBA, and the pixel dimensions of the buffer.
    expect(s).toContain("a=T");
    expect(s).toContain("f=32");
    expect(s).toContain("s=2");
    expect(s).toContain("v=2");
  });

  test("encodes the pixel buffer as base64", () => {
    const out = encodeImageToKitty(solidImage(1, 1, [1, 2, 3, 4])) as string;
    const payload = out.slice(out.indexOf(";") + 1, out.indexOf(`${ESC}\\`));
    expect(Buffer.from(payload, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("chunks large payloads with m=1 on all but the last chunk", () => {
    // 64×64 RGBA ≈ 16 KiB → ~21 KiB base64, well over the 4096-byte chunk cap.
    const out = encodeImageToKitty(
      solidImage(64, 64, [10, 20, 30, 255])
    ) as string;
    // Each chunk is an APC sequence terminated by ESC \; split on the introducer.
    const chunks = out
      .split(`${ESC}_G`)
      .filter((c) => c.length > 0)
      .map((c) => `${ESC}_G${c}`);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk but the last declares more data follows.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk).toContain("m=1");
    }
    expect(chunks.at(-1)).toContain("m=0");
    // Metadata keys ride only the first chunk.
    expect(chunks[0]).toContain("f=32");
    expect(chunks[1]).not.toContain("f=32");
  });

  test("downscales wide images to the max width", () => {
    const out = encodeImageToKitty(
      solidImage(2000, 10, [0, 0, 0, 255])
    ) as string;
    expect(out).toContain("s=800");
  });
});

describe("imageBytesToKitty", () => {
  test("decodes PNG bytes and encodes them to kitty graphics", () => {
    const png = toPngBytes(solidImage(3, 3, [0, 128, 255, 255]));
    const out = imageBytesToKitty(png, "image/png");
    expect(out).toBeDefined();
    expect((out as string).startsWith(`${ESC}_G`)).toBe(true);
  });

  test("returns undefined for an unsupported format", () => {
    expect(
      imageBytesToKitty(new Uint8Array([1, 2, 3]), "text/plain")
    ).toBeUndefined();
  });

  test("returns undefined for bytes that fail to decode", () => {
    // PNG magic bytes but a truncated/garbage body.
    const bogus = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(imageBytesToKitty(bogus, "image/png")).toBeUndefined();
  });
});
