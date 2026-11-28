import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWranglerConfig } from "../../../../src/lib/wizard/cloudflare/wrangler/create-wrangler-config.js";

const { clackMocks } = vi.hoisted(() => {
  const info = vi.fn();
  const success = vi.fn();

  return {
    clackMocks: {
      info,
      success,
    },
  };
});

vi.mock("@clack/prompts", () => {
  return {
    log: {
      info: clackMocks.info,
      success: clackMocks.success,
    },
  };
});

describe("createWranglerConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(path.join(tmpdir(), "create-wrangler-config-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a wrangler.jsonc file with basic configuration", () => {
    createWranglerConfig();

    const content = readFileSync(path.join(tmpDir, "wrangler.jsonc"), "utf-8");
    expect(content).toContain('"name": "my-worker"');
    expect(content).toContain('"main": "src/index.ts"');
    expect(clackMocks.success).toHaveBeenCalledOnce();
  });
});
