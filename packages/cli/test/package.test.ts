import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("package.json", () => {
  test("has no runtime dependencies", async () => {
    const pkg: { dependencies?: Record<string, string> } = JSON.parse(
      await readFile("package.json", "utf-8")
    );

    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
