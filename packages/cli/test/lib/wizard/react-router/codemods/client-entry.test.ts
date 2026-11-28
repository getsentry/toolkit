import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { instrumentClientEntry } from "../../../../../src/lib/wizard/react-router/codemods/client.entry.js";

vi.mock("@clack/prompts", () => {
  const mock = {
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
    },
  };
  return {
    default: mock,
    ...mock,
  };
});

describe("instrumentClientEntry", () => {
  const fixturesDir = path.join(__dirname, "fixtures", "client-entry");
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create unique tmp directory for each test
    tmpDir = path.join(
      fixturesDir,
      "tmp",
      `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    );
    tmpFile = path.join(tmpDir, "entry.client.tsx");

    // Ensure tmp directory exists
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up tmp directory
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("should add Sentry import and initialization with all features enabled", async () => {
    const basicContent = readFileSync(
      path.join(fixturesDir, "basic.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, basicContent);

    await instrumentClientEntry(
      tmpFile,
      "test-dsn",
      true,
      true,
      false,
      false,
      true,
    );

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );
    expect(modifiedContent).toContain("Sentry.init({");
    expect(modifiedContent).toContain('dsn: "test-dsn"');
    expect(modifiedContent).toContain("integrations: [");
    expect(modifiedContent).toContain("Sentry.reactRouterTracingIntegration()");
    expect(modifiedContent).toContain("Sentry.replayIntegration(");
    expect(modifiedContent).toContain("onError={Sentry.sentryOnError}");
  });

  it("should add Sentry initialization with only tracing enabled", async () => {
    const basicContent = readFileSync(
      path.join(fixturesDir, "basic.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, basicContent);

    await instrumentClientEntry(tmpFile, "test-dsn", true, false, false);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );
    expect(modifiedContent).toContain("Sentry.init({");
    expect(modifiedContent).toContain('dsn: "test-dsn"');
    expect(modifiedContent).toContain("integrations: [");
    expect(modifiedContent).toContain("Sentry.reactRouterTracingIntegration()");
    expect(modifiedContent).not.toContain("Sentry.replayIntegration()");
  });

  it("should add Sentry initialization with only replay enabled", async () => {
    const basicContent = readFileSync(
      path.join(fixturesDir, "basic.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, basicContent);

    await instrumentClientEntry(tmpFile, "test-dsn", false, true, false);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );
    expect(modifiedContent).toContain("Sentry.init({");
    expect(modifiedContent).toContain('dsn: "test-dsn"');
    expect(modifiedContent).toContain("integrations: [");
    expect(modifiedContent).not.toContain(
      "Sentry.reactRouterTracingIntegration()",
    );
    expect(modifiedContent).toContain("Sentry.replayIntegration(");
  });

  it("should add minimal Sentry initialization when all features are disabled", async () => {
    const basicContent = readFileSync(
      path.join(fixturesDir, "basic.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, basicContent);

    await instrumentClientEntry(tmpFile, "test-dsn", false, false, false);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );
    expect(modifiedContent).toContain("Sentry.init({");
    expect(modifiedContent).toContain('dsn: "test-dsn"');
    expect(modifiedContent).toContain("integrations: []");
    expect(modifiedContent).not.toContain(
      "Sentry.reactRouterTracingIntegration()",
    );
    expect(modifiedContent).not.toContain("Sentry.replayIntegration()");
  });

  it("should write the dataCollection preset when reduceDataCollection is true", async () => {
    const basicContent = readFileSync(
      path.join(fixturesDir, "basic.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, basicContent);

    await instrumentClientEntry(tmpFile, "test-dsn", true, true, true);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain("userInfo: false,");
    expect(modifiedContent).toContain(
      'httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] }',
    );
    expect(modifiedContent).not.toContain("// userInfo: false,");
    expect(modifiedContent).not.toContain(
      "uncomment the lines below. For more info visit:",
    );
  });

  it("should keep the commented dataCollection hint when reduceDataCollection is false", async () => {
    const basicContent = readFileSync(
      path.join(fixturesDir, "basic.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, basicContent);

    await instrumentClientEntry(tmpFile, "test-dsn", true, true, false);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain("// userInfo: false,");
    expect(modifiedContent).toContain("// httpBodies: [],");
    expect(modifiedContent).toContain(
      "uncomment the lines below. For more info visit:",
    );
  });

  it("should not add Sentry.init when Sentry content already exists but still add onError", async () => {
    const withSentryContent = readFileSync(
      path.join(fixturesDir, "with-sentry.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, withSentryContent);

    await instrumentClientEntry(
      tmpFile,
      "test-dsn",
      true,
      true,
      false,
      false,
      true,
    );

    const modifiedContent = readFileSync(tmpFile, "utf8");

    // Should not duplicate Sentry.init
    const initCount = (modifiedContent.match(/Sentry\.init\(/g) || []).length;
    expect(initCount).toBe(1);

    // Should still add onError prop to HydratedRouter
    expect(modifiedContent).toContain("onError={Sentry.sentryOnError}");
  });

  it("should insert Sentry initialization after imports", async () => {
    const withImportsContent = readFileSync(
      path.join(fixturesDir, "with-imports.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, withImportsContent);

    await instrumentClientEntry(tmpFile, "test-dsn", true, false, false);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );
    expect(modifiedContent).toContain("Sentry.init({");

    // Check that the Sentry import is before the init call
    const sentryImportIndex = modifiedContent.indexOf(
      'import * as Sentry from "@sentry/react-router";',
    );
    const sentryInitIndex = modifiedContent.indexOf("Sentry.init({");
    expect(sentryImportIndex).toBeLessThan(sentryInitIndex);
  });

  it("should handle files with no imports", async () => {
    const noImportsContent = readFileSync(
      path.join(fixturesDir, "no-imports.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, noImportsContent);

    await instrumentClientEntry(tmpFile, "test-dsn", false, true, false);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );
    expect(modifiedContent).toContain("Sentry.init({");
    expect(modifiedContent).toContain("Sentry.replayIntegration(");
  });

  it("should preserve existing code structure", async () => {
    const complexContent = readFileSync(
      path.join(fixturesDir, "complex.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, complexContent);

    await instrumentClientEntry(tmpFile, "test-dsn", true, true, false);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );
    expect(modifiedContent).toContain("Sentry.init({");

    // Original content should still be there
    expect(modifiedContent).toContain("startTransition");
    expect(modifiedContent).toContain("hydrateRoot");
    expect(modifiedContent).toContain("<StrictMode>");
  });

  describe("Instrumentation API", () => {
    it("should add instrumentation API setup when enabled", async () => {
      const basicContent = readFileSync(
        path.join(fixturesDir, "basic.tsx"),
        "utf8",
      );

      writeFileSync(tmpFile, basicContent);

      await instrumentClientEntry(
        tmpFile,
        "test-dsn",
        true,
        false,
        false,
        true,
      );

      const modifiedContent = readFileSync(tmpFile, "utf8");

      expect(modifiedContent).toContain(
        "const tracing = Sentry.reactRouterTracingIntegration();",
      );
      expect(modifiedContent).toContain("integrations: [tracing]");
      expect(modifiedContent).toContain(
        "instrumentations={[tracing.clientInstrumentation]}",
      );
    });

    it("should combine instrumentation API with replay", async () => {
      const basicContent = readFileSync(
        path.join(fixturesDir, "basic.tsx"),
        "utf8",
      );

      writeFileSync(tmpFile, basicContent);

      await instrumentClientEntry(tmpFile, "test-dsn", true, true, false, true);

      const modifiedContent = readFileSync(tmpFile, "utf8");

      expect(modifiedContent).toContain(
        "const tracing = Sentry.reactRouterTracingIntegration();",
      );
      expect(modifiedContent).toContain(
        "integrations: [tracing, Sentry.replayIntegration()]",
      );
      expect(modifiedContent).toContain(
        "instrumentations={[tracing.clientInstrumentation]}",
      );
    });

    it("should not use instrumentation API when useInstrumentationAPI is false", async () => {
      const basicContent = readFileSync(
        path.join(fixturesDir, "basic.tsx"),
        "utf8",
      );

      writeFileSync(tmpFile, basicContent);

      await instrumentClientEntry(
        tmpFile,
        "test-dsn",
        true,
        false,
        false,
        false,
      );

      const modifiedContent = readFileSync(tmpFile, "utf8");

      expect(modifiedContent).not.toContain("const tracing");
      expect(modifiedContent).toContain(
        "Sentry.reactRouterTracingIntegration()",
      );
      expect(modifiedContent).not.toContain("instrumentations");
    });
  });
});
