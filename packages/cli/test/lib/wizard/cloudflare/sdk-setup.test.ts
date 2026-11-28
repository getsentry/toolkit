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

  it("creates a default entry point and wraps it with Sentry", async () => {
    const template =
      'export default { async fetch() { return new Response("ᕕ(⌐■_■)ᕗ ♪♬"); } }';
    vi.spyOn(
      templates,
      "getCloudflareWorkerTemplateWithHandler",
    ).mockReturnValue(template);

    await createSentryInitFile(testDsn, testFeatures, false);

    const expectedPath = path.join(tmpDir, "src/index.ts");
    const content = fs.readFileSync(expectedPath, "utf-8");

    expect(clackMocks.success).toHaveBeenCalledWith("Created src/index.ts.");
    expect(content).toContain("Sentry.withSentry(");
    expect(content).toContain(testDsn);
    expect(content).toContain("ᕕ(⌐■_■)ᕗ ♪♬");
  });

  it("wraps the starter worker template", async () => {
    await createSentryInitFile(testDsn, testFeatures, false);

    const content = fs.readFileSync(path.join(tmpDir, "src/index.ts"), "utf-8");

    expect(content).toContain('from "@sentry/cloudflare"');
    expect(content).toContain("Sentry.withSentry(");
    expect(clackMocks.warn).not.toHaveBeenCalled();
  });

  it("wraps an existing default entry point instead of overwriting it", async () => {
    const existing =
      'export default { async fetch() { return new Response("mine"); } }';
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src/index.ts"), existing);

    await createSentryInitFile(testDsn, testFeatures, false);

    const content = fs.readFileSync(path.join(tmpDir, "src/index.ts"), "utf-8");
    expect(content).toContain('"mine"');
    expect(content).toContain("Sentry.withSentry(");
  });

  describe("when entry point is found in wrangler config", () => {
    describe("and the entry point file exists", () => {
      beforeEach(() => {
        fs.mkdirSync(path.join(tmpDir, "src"));
        fs.writeFileSync(
          path.join(tmpDir, defaultEntryPoint),
          "export default { async fetch() { return new Response(); } }",
        );
        getEntryPointFromWranglerConfigMock.mockReturnValue(defaultEntryPoint);
      });

      it("wraps the worker with Sentry when wrapping succeeds", async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, "wrapWorkerWithSentry")
          .mockResolvedValue(true);

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          testFeatures,
          false,
        );
      });

      it("doesn't report a wrap when Sentry is already set up", async () => {
        vi.spyOn(wrapWorker, "wrapWorkerWithSentry").mockResolvedValue(false);

        await createSentryInitFile(testDsn, testFeatures, false);

        expect(clackMocks.success).not.toHaveBeenCalledWith(
          expect.stringContaining("Wrapped"),
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
          .mockResolvedValue(true);

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
          .mockResolvedValue(true);

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
          .mockResolvedValue(true);

        await createSentryInitFile(testDsn, testFeatures, true);

        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          path.join(tmpDir, defaultEntryPoint),
          testDsn,
          testFeatures,
          true,
        );
      });
    });

    it("writes a JavaScript starter worker to a missing .js entry point", async () => {
      getEntryPointFromWranglerConfigMock.mockReturnValue("src/worker.js");

      await createSentryInitFile(testDsn, testFeatures, false);

      const content = fs.readFileSync(
        path.join(tmpDir, "src/worker.js"),
        "utf-8",
      );
      expect(content).toContain("Sentry.withSentry(");
      expect(content).not.toContain("satisfies");
      expect(content).not.toContain("Promise<Response>");
    });

    describe("and the entry point file does not exist", () => {
      beforeEach(() => {
        getEntryPointFromWranglerConfigMock.mockReturnValue("src/worker.ts");
      });

      it("creates the configured entry point and wraps it", async () => {
        const wrapWorkerWithSentrySpy = vi
          .spyOn(wrapWorker, "wrapWorkerWithSentry")
          .mockResolvedValue(true);

        await createSentryInitFile(testDsn, testFeatures, false);

        const createdPath = path.join(tmpDir, "src/worker.ts");
        expect(fs.existsSync(createdPath)).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, defaultEntryPoint))).toBe(false);
        expect(wrapWorkerWithSentrySpy).toHaveBeenCalledWith(
          createdPath,
          testDsn,
          testFeatures,
          false,
        );
      });
    });
  });
});
