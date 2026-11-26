import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getEntryPointFromWranglerConfig } from "../../../../src/lib/wizard/cloudflare/wrangler/get-entry-point-from-wrangler-config.js";

describe("getEntryPointFromWranglerConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "get-entry-point-from-wrangler-config-"),
    );

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }

    vi.restoreAllMocks();
  });

  it("returns undefined if no config file exists", () => {
    const result = getEntryPointFromWranglerConfig();

    expect(result).toBeUndefined();
  });

  it("parses main from wrangler.toml", () => {
    fs.writeFileSync(
      path.join(tmpDir, "wrangler.toml"),
      `name = "my-worker"
main = "src/worker.ts"
compatibility_date = "2024-01-01"`,
    );

    const result = getEntryPointFromWranglerConfig();

    expect(result).toBe("src/worker.ts");
  });

  it("parses main from wrangler.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "wrangler.json"),
      JSON.stringify({ name: "my-worker", main: "src/deeplink/index.ts" }),
    );

    const result = getEntryPointFromWranglerConfig();

    expect(result).toBe("src/deeplink/index.ts");
  });

  it("parses main from wrangler.jsonc with comments", () => {
    fs.writeFileSync(
      path.join(tmpDir, "wrangler.jsonc"),
      `{
  // Comment
  "name": "my-worker",
  "main": "src/inside-app/index.ts"
}`,
    );

    const result = getEntryPointFromWranglerConfig();

    expect(result).toBe("src/inside-app/index.ts");
  });

  it("returns undefined if main field is not specified", () => {
    fs.writeFileSync(
      path.join(tmpDir, "wrangler.toml"),
      `name = "my-worker"
compatibility_date = "2024-01-01"`,
    );

    const result = getEntryPointFromWranglerConfig();

    expect(result).toBeUndefined();
  });

  it("returns undefined if JSON parsing fails", () => {
    fs.writeFileSync(path.join(tmpDir, "wrangler.json"), "{ invalid json }");

    const result = getEntryPointFromWranglerConfig();

    expect(result).toBeUndefined();
  });
});
