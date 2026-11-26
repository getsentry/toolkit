import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findWranglerConfig } from "../../../../src/lib/wizard/cloudflare/wrangler/find-wrangler-config.js";

describe("findWranglerConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "find-wrangler-config-"));

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }

    vi.restoreAllMocks();
  });

  it("returns wrangler.toml if it exists", () => {
    fs.writeFileSync(path.join(tmpDir, "wrangler.toml"), "");

    const result = findWranglerConfig();

    expect(result).toBe("wrangler.toml");
  });

  it("returns wrangler.jsonc if it exists", () => {
    fs.writeFileSync(path.join(tmpDir, "wrangler.jsonc"), "{}");

    const result = findWranglerConfig();

    expect(result).toBe("wrangler.jsonc");
  });

  it("returns wrangler.json if it exists", () => {
    fs.writeFileSync(path.join(tmpDir, "wrangler.json"), "{}");

    const result = findWranglerConfig();

    expect(result).toBe("wrangler.json");
  });

  it("returns wrangler.jsonc when multiple config files exist (priority order)", () => {
    fs.writeFileSync(path.join(tmpDir, "wrangler.toml"), "");
    fs.writeFileSync(path.join(tmpDir, "wrangler.jsonc"), "{}");
    fs.writeFileSync(path.join(tmpDir, "wrangler.json"), "{}");

    const result = findWranglerConfig();

    expect(result).toBe("wrangler.jsonc");
  });

  it("returns wrangler.json when jsonc and json do exist but toml does not", () => {
    fs.writeFileSync(path.join(tmpDir, "wrangler.toml"), "{}");
    fs.writeFileSync(path.join(tmpDir, "wrangler.json"), "{}");

    const result = findWranglerConfig();

    expect(result).toBe("wrangler.json");
  });

  it("returns undefined if no config file exists", () => {
    const result = findWranglerConfig();

    expect(result).toBeUndefined();
  });
});
