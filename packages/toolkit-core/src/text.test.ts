import { describe, expect, it } from "vitest";
import { sliceAtCodePointBoundary } from "./text.js";

const LOCK = "\u{1F512}";

function isWellFormed(text: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    text,
  );
}

describe("sliceAtCodePointBoundary", () => {
  it("backs off when the end lands between the halves of an emoji", () => {
    const text = `${"a".repeat(119)}${LOCK}tail`;

    const result = sliceAtCodePointBoundary(text, 0, 120);

    expect(result).toBe("a".repeat(119));
    expect(isWellFormed(result)).toBe(true);
  });

  it("keeps a whole emoji that ends exactly at the bound", () => {
    const text = `${"a".repeat(118)}${LOCK}tail`;

    expect(sliceAtCodePointBoundary(text, 0, 120)).toBe(
      `${"a".repeat(118)}${LOCK}`,
    );
  });

  it("moves a negative start past the low half of an emoji", () => {
    const text = `/src/${LOCK}/file.ts`;
    const lowHalfIndex = text.indexOf(LOCK) + 1;

    const result = sliceAtCodePointBoundary(text, lowHalfIndex - text.length);

    expect(result).toBe("/file.ts");
    expect(isWellFormed(result)).toBe(true);
  });

  it("matches String.prototype.slice when no pair is split", () => {
    const text = `hello ${LOCK} world`;

    expect(sliceAtCodePointBoundary(text, 0, 5)).toBe(text.slice(0, 5));
    expect(sliceAtCodePointBoundary(text, -5)).toBe(text.slice(-5));
    expect(sliceAtCodePointBoundary(text, 0, 100)).toBe(text);
  });

  it("never returns a lone surrogate for any end bound", () => {
    const text = `${LOCK}a${LOCK}${LOCK}b`;

    for (let end = 0; end <= text.length; end += 1) {
      expect(isWellFormed(sliceAtCodePointBoundary(text, 0, end))).toBe(true);
    }
  });
});
