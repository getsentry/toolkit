import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SemVer } from "semver";
import {
  addNuxtOverrides,
  addSDKModule,
  createConfigFiles,
} from "../../../../src/lib/wizard/nuxt/sdk-setup.js";
import { WizardExitError } from "../../../../src/lib/errors.js";
import type { PackageManager } from "../../../../src/lib/wizard/utils/package-manager.js";

const { askShouldAddPackageOverrideMock } = vi.hoisted(() => ({
  askShouldAddPackageOverrideMock: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  outro: vi.fn(),
  confirm: vi.fn().mockResolvedValue(false),
  isCancel: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual("../../../../src/lib/wizard/utils/clack/index.js")),
  askShouldAddPackageOverride: askShouldAddPackageOverrideMock,
  featureSelectionPrompt: vi.fn().mockResolvedValue({
    performance: true,
    replay: false,
  }),
}));

describe("addNuxtOverrides", () => {
  const addOverride = vi.fn();
  const packageManager = { addOverride } as unknown as PackageManager;

  beforeEach(() => {
    vi.clearAllMocks();
    askShouldAddPackageOverrideMock.mockResolvedValue(true);
  });

  it("adds an ofetch override for Nuxt < 3.14.0", async () => {
    await addNuxtOverrides(packageManager, new SemVer("3.13.2"));

    expect(askShouldAddPackageOverrideMock).toHaveBeenCalledWith(
      "ofetch",
      "^1.4.0",
    );
    expect(addOverride).toHaveBeenCalledWith("ofetch", "^1.4.0");
  });

  it("does not add the override if the user declines", async () => {
    askShouldAddPackageOverrideMock.mockResolvedValue(false);

    await addNuxtOverrides(packageManager, new SemVer("3.13.2"));

    expect(addOverride).not.toHaveBeenCalled();
  });

  it.each(["3.14.0", "4.0.0"])(
    "does not prompt for Nuxt %s",
    async (version) => {
      await addNuxtOverrides(packageManager, new SemVer(version));

      expect(askShouldAddPackageOverrideMock).not.toHaveBeenCalled();
      expect(addOverride).not.toHaveBeenCalled();
    },
  );

  it("does not prompt if the Nuxt version is unknown", async () => {
    await addNuxtOverrides(packageManager, null);

    expect(askShouldAddPackageOverrideMock).not.toHaveBeenCalled();
  });
});

describe("createConfigFiles", () => {
  it("prints the dataCollection preset when the user keeps existing configs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wizard-nuxt-config-"));
    const originalCwd = process.cwd();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      writeFileSync(path.join(dir, "sentry.client.config.js"), "");
      writeFileSync(path.join(dir, "sentry.server.config.js"), "");
      process.chdir(dir);

      await createConfigFiles("https://key@o1.ingest.sentry.io/2", true);

      const printed = write.mock.calls.map(([chunk]) => String(chunk));
      expect(printed).toHaveLength(2);
      for (const snippet of printed) {
        expect(snippet).toContain("dataCollection: {");
      }
    } finally {
      process.chdir(originalCwd);
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("addSDKModule", () => {
  it("prints the manual steps and aborts cleanly before the config files when the config does not parse", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nuxt-module-"));
    const originalCwd = process.cwd();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const config = path.join(dir, "nuxt.config.ts");
    writeFileSync(config, "export default defineNuxtConfig({ modules: [ ");
    try {
      process.chdir(dir);

      // The same two steps, in order, as `runNuxtWizard`'s configure-sdk step.
      const configureSdk = async () => {
        await addSDKModule(config, {
          org: "my-org",
          project: "my-project",
          url: "https://sentry.io/",
          selfHosted: false,
        });
        await createConfigFiles("https://key@o1.ingest.sentry.io/2", false);
      };

      await expect(configureSdk()).rejects.toBeInstanceOf(WizardExitError);
      expect(
        write.mock.calls.some(([chunk]) =>
          String(chunk).includes("@sentry/nuxt/module"),
        ),
      ).toBe(true);
      expect(existsSync(path.join(dir, "sentry.client.config.ts"))).toBe(false);
      expect(existsSync(path.join(dir, "sentry.server.config.ts"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
