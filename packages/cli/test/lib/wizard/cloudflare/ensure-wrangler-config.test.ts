import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWranglerConfig } from "../../../../src/lib/wizard/cloudflare/wrangler/ensure-wrangler-config.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { clackMocks } = vi.hoisted(() => {
  const info = vi.fn();
  const step = vi.fn();
  const success = vi.fn();

  return {
    clackMocks: {
      info,
      step,
      success,
    },
  };
});

vi.mock("@clack/prompts", () => {
  return {
    log: {
      info: clackMocks.info,
      step: clackMocks.step,
      success: clackMocks.success,
    },
  };
});

describe("ensure-wrangler-config", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-wrangler-config-"));

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }

    vi.restoreAllMocks();
  });

  it("does nothing if config already exists", () => {
    fs.writeFileSync(path.join(tmpDir, "wrangler.jsonc"), "{}");

    ensureWranglerConfig();

    expect(clackMocks.info).toHaveBeenCalledWith(
      expect.stringContaining("Found existing Wrangler config"),
    );
    expect(fs.existsSync(path.join(tmpDir, "wrangler.jsonc"))).toBe(true);
  });

  it("creates config if none exists", () => {
    expect(fs.existsSync(path.join(tmpDir, "wrangler.jsonc"))).toBe(false);

    ensureWranglerConfig();

    expect(clackMocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Found existing Wrangler config"),
    );
    expect(fs.existsSync(path.join(tmpDir, "wrangler.jsonc"))).toBe(true);
  });
});
