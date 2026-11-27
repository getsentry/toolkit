import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSentryInit } from "../../../../src/lib/wizard/react-native/javascript.js";

const mocks = vi.hoisted(() => ({
  appPath: "",
  select: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../../../src/lib/wizard/react-native/glob.js", () => ({
  getFirstMatchedPath: () => mocks.appPath,
}));

vi.mock("@clack/prompts", () => ({
  select: mocks.select,
  isCancel: () => false,
  log: { step: vi.fn(), success: mocks.success, warn: mocks.warn },
}));

describe("addSentryInit", () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    dir = mkdtempSync(join(tmpdir(), "rn-wizard-"));
    mocks.appPath = join(dir, "App.js");
    mocks.select.mockResolvedValue(true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows manual instructions instead of reporting success when the app file has no import", async () => {
    const source = `const React = require("react")\nmodule.exports = () => null\n`;
    writeFileSync(mocks.appPath, source);

    await addSentryInit({ dsn: "dsn" });

    expect(readFileSync(mocks.appPath, "utf-8")).toBe(source);
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
