import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as { dependencies: Record<string, string> };

describe("Local runtime dependencies", () => {
  test("declares tslib for dialog dependencies that import its ESM helpers", () => {
    expect(packageJson.dependencies.tslib).toBeDefined();
  });
});
