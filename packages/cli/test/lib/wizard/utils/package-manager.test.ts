import { describe, expect, it } from "vitest";
import {
  _detectPackageManger,
  NPM,
  PNPM,
  YARN_V1,
} from "../../../../src/lib/wizard/utils/package-manager.js";

describe("_detectPackageManager", () => {
  it("returns the detected package manager if exactly one is found", () => {
    const pnpm = { ...PNPM, detect: () => true };

    const packageManager = _detectPackageManger([
      { ...NPM, detect: () => false },
      { ...YARN_V1, detect: () => false },
      pnpm,
    ]);

    expect(packageManager).toBe(pnpm);
  });

  it("returns null if no package manager is found", () => {
    const packageManager = _detectPackageManger([
      { ...NPM, detect: () => false },
      { ...YARN_V1, detect: () => false },
    ]);
    expect(packageManager).toBeNull();
  });

  it("returns null if multiple package managers are found", () => {
    const packageManager = _detectPackageManger([
      { ...NPM, detect: () => true },
      { ...YARN_V1, detect: () => true },
    ]);
    expect(packageManager).toBeNull();
  });
});
