import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isNuxtV4 } from "../../../../src/lib/wizard/nuxt/utils.js";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

let dir: string;
let nuxtConfig: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wizard-nuxt-utils-"));
  nuxtConfig = path.join(dir, "nuxt.config.ts");
  writeFileSync(nuxtConfig, "export default defineNuxtConfig({});\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isNuxtV4", () => {
  it.each(["^4.0.0", "4.0.0-rc.1", "^4.2.0-beta.1"])(
    "detects %s as Nuxt 4",
    async (version) => {
      expect(await isNuxtV4(nuxtConfig, version)).toBe(true);
    },
  );

  it("does not treat Nuxt 3 as Nuxt 4", async () => {
    expect(await isNuxtV4(nuxtConfig, "^3.15.0")).toBe(false);
  });

  it("reads compatibilityVersion when the version is unknown", async () => {
    writeFileSync(
      nuxtConfig,
      "export default defineNuxtConfig({ future: { compatibilityVersion: 4 } });\n",
    );
    expect(await isNuxtV4(nuxtConfig, undefined)).toBe(true);
  });
});
