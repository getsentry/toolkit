import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSentryInitFile } from "../../../../src/lib/wizard/cloudflare/sdk-setup.js";
import { defaultEntryPoint } from "../../../../src/lib/wizard/cloudflare/wrangler/get-entry-point-from-wrangler-config.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as templates from "../../../../src/lib/wizard/cloudflare/templates.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as wrapWorker from "../../../../src/lib/wizard/cloudflare/wrap-worker.js";

const { clackMocks } = vi.hoisted(() => {
  const info = vi.fn();
  const warn = vi.fn();
  const success = vi.fn();
  const step = vi.fn();
  const note = vi.fn();

  return {
    clackMocks: {
      info,
      warn,
      success,
      step,
      note,
    },
  };
});

vi.mock("@clack/prompts", () => ({
  log: {
    info: clackMocks.info,
    warn: clackMocks.warn,
    success: clackMocks.success,
    step: clackMocks.step,
  },
  note: clackMocks.note,
}));

const { getEntryPointFromWranglerConfigMock } = vi.hoisted(() => ({
  getEntryPointFromWranglerConfigMock: vi.fn(),
}));

vi.mock(
  "../../../../src/lib/wizard/cloudflare/wrangler/get-entry-point-from-wrangler-config.js",
  () => ({
    getEntryPointFromWranglerConfig: getEntryPointFromWranglerConfigMock,
    defaultEntryPoint: "src/index.ts",
  }),
);

describe("createSentryInitFile", () => {
  let tmpDir: string;
  const testDsn = "https://example@sentry.io/123";
  const testFeatures = {
    performance: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getEntryPointFromWranglerConfigMock.mockReset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-setup-test-"));

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }

    vi.restoreAllMocks();
  });

  it("creates a new default entry point file", async () => {
    const template =
      'export default { async fetch() { return new Response("ᕕ(⌐■_■)ᕗ ♪♬"); } }';
    const getCloudflareWorkerTemplateWithHandlerSpy = vi
      .spyOn(templates, "getCloudflareWorkerTemplateWithHandler")
      .mockReturnValue(template);

    await createSentryInitFile(testDsn, testFeatures, false);

    const expectedPath = path.join(tmpDir, "src/index.ts");
    const content = fs.readFileSync(expectedPath, "utf-8");

    expect(clackMocks.info).toHaveBeenCalledWith(
      "No entry point found in wrangler config, creating a new one.",
    );
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(content).toBe(template);
    expect(clackMocks.success).toHaveBeenCalledWith("Created src/index.ts.");
    expect(getCloudflareWorkerTemplateWithHandlerSpy).toHaveBeenCalled();
  });

  describe("when entry point is found in wrangler config", () => {
    describe("and the entry point file exists", () => {
      beforeEach(async () => {
        await createSentryInitFile(testDsn, testFeatures, false);
        getEntryPointFromWranglerConfigMock.mockReturnValue(defaultEntryPoint);
      });

      it("wraps the worker with Sentry when wrapping succeeds", async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, "wrapWorkerWithSentry")
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          testFeatures,
          false,
        );
      });

      it("handles wrapping failure gracefully", async () => {
        vi.spyOn(wrapWorker, "wrapWorkerWithSentry").mockRejectedValue(
          new Error("Wrapping failed"),
        );

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(clackMocks.warn).toHaveBeenCalledWith(
          "Failed to wrap worker automatically.",
        );
        expect(clackMocks.step).toHaveBeenCalledWith(
          "Please wrap your handler with Sentry initialization:",
        );
        expect(clackMocks.note).toHaveBeenCalledWith(
          expect.stringContaining("import * as Sentry"),
        );
      });

      it("shows template with correct DSN when wrapping fails", async () => {
        vi.spyOn(wrapWorker, "wrapWorkerWithSentry").mockRejectedValue(
          new Error("Failed"),
        );
        const getCloudflareWorkerTemplateSpy = vi
          .spyOn(templates, "getCloudflareWorkerTemplate")
          .mockReturnValue("template with dsn");

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(getCloudflareWorkerTemplateSpy).toHaveBeenCalledWith(
          testDsn,
          testFeatures,
          false,
        );
        expect(clackMocks.note).toHaveBeenCalledWith("template with dsn");
      });

      it("passes performance feature flag correctly", async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, "wrapWorkerWithSentry")
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, { performance: false }, false);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          { performance: false },
          false,
        );
      });

      it("passes performance feature flag when enabled", async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, "wrapWorkerWithSentry")
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, { performance: true }, false);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          { performance: true },
          false,
        );
      });

      it("passes reduceDataCollection through to the worker wrapper", async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, "wrapWorkerWithSentry")
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, testFeatures, true);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          testFeatures,
          true,
        );
      });
    });

    describe("and the entry point file does not exist", () => {
      it("does not throw an error", async () => {
        vi.spyOn(wrapWorker, "wrapWorkerWithSentry").mockResolvedValue(
          undefined,
        );

        await expect(
          createSentryInitFile(testDsn, testFeatures, false),
        ).resolves.not.toThrow();
      });

      it("does not call wrapWorkerWithSentry", async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, "wrapWorkerWithSentry")
          .mockResolvedValue(undefined);

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(wrapWorkerWithSentrySpy).not.toHaveBeenCalled();
      });
    });
  });
});
