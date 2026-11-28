import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { wrapWorkerWithSentry } from "../../../../src/lib/wizard/cloudflare/wrap-worker.js";

describe("wrapWorkerWithSentry", () => {
  const fixturesDir = path.join(__dirname, "fixtures", "worker");
  let tmpDir: string;

  function copyFixture(fixtureName: string): string {
    const content = fs.readFileSync(
      path.join(fixturesDir, fixtureName),
      "utf-8",
    );
    const targetPath = path.join(tmpDir, "worker.ts");
    fs.writeFileSync(targetPath, content);
    return targetPath;
  }

  function readResult(): string {
    return fs.readFileSync(path.join(tmpDir, "worker.ts"), "utf-8");
  }

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrap-worker-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }

    vi.restoreAllMocks();
  });

  describe("basic wrapping", () => {
    it("wraps a simple worker export with Sentry", async () => {
      const filePath = copyFixture("simple-with-satisfies.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-test-dsn",
        {
          performance: false,
        },
        false,
      );

      const result = readResult();

      expect(result).toMatchSnapshot();
    });

    it("preserves complex handler logic", async () => {
      const filePath = copyFixture("complex-handler.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: false,
        },
        false,
      );

      const result = readResult();

      expect(result).toMatchSnapshot();
    });
  });

  describe("performance monitoring", () => {
    it("includes tracesSampleRate when performance is enabled", async () => {
      const filePath = copyFixture("simple.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: true,
        },
        false,
      );

      const result = readResult();

      expect(result).toMatchSnapshot();
    });

    it("omits tracesSampleRate when performance is disabled", async () => {
      const filePath = copyFixture("simple.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: false,
        },
        false,
      );

      const result = readResult();

      expect(result).toMatchSnapshot();
    });
  });

  describe("data collection", () => {
    it("includes the dataCollection preset when reduceDataCollection is enabled", async () => {
      const filePath = copyFixture("simple.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: true,
        },
        true,
      );

      const result = readResult();

      expect(result).toContain("userInfo: false");
      // Recast prints the nested deny-list objects multiline.
      expect(result).toContain("httpHeaders: {");
      expect(result).toContain(
        'deny: ["forwarded", "-ip", "remote-", "via", "-user"]',
      );

      expect(result).toMatchSnapshot();
    });

    it("omits the dataCollection preset when reduceDataCollection is disabled", async () => {
      const filePath = copyFixture("simple.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: true,
        },
        false,
      );

      const result = readResult();

      expect(result).not.toContain("dataCollection");
    });
  });

  describe("import handling", () => {
    it("adds Sentry import at the beginning of the file", async () => {
      const filePath = copyFixture("with-comment.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: false,
        },
        false,
      );

      const result = readResult();

      expect(result).toMatchSnapshot();
    });

    it("preserves existing imports", async () => {
      const filePath = copyFixture("with-import.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: false,
        },
        false,
      );

      const result = readResult();

      expect(result).toMatchSnapshot();
    });

    it("preserves an external default export", async () => {
      const filePath = copyFixture("external-default-export.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: false,
        },
        false,
      );

      const result = readResult();

      expect(result).toMatchSnapshot();
    });
  });

  describe("idempotency", () => {
    it("does not wrap again if Sentry is already present", async () => {
      const filePath = copyFixture("already-wrapped.ts");
      const originalContent = fs.readFileSync(
        path.join(fixturesDir, "already-wrapped.ts"),
        "utf-8",
      );

      await expect(
        wrapWorkerWithSentry(
          filePath,
          "new-dsn",
          {
            performance: true,
          },
          false,
        ),
      ).resolves.toBe(false);

      const result = readResult();

      expect(result).toBe(originalContent);
    });

    it("does not modify if @sentry/cloudflare is imported", async () => {
      const filePath = copyFixture("with-sentry-import.ts");
      const originalContent = fs.readFileSync(
        path.join(fixturesDir, "with-sentry-import.ts"),
        "utf-8",
      );

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: false,
        },
        false,
      );

      const result = readResult();

      expect(result).toBe(originalContent);
    });
  });

  describe("DSN handling", () => {
    it("uses the provided DSN", async () => {
      const filePath = copyFixture("simple.ts");

      const testDsn =
        "https://d7a9abbecd95ed7d0f5b6c965f5fb6ba@o447951.ingest.us.sentry.io/4510147615391744";

      await wrapWorkerWithSentry(
        filePath,
        testDsn,
        {
          performance: false,
        },
        false,
      );

      const result = readResult();

      expect(result).toMatchSnapshot();
    });
  });

  describe("edge cases", () => {
    it("handles worker without satisfies clause", async () => {
      const filePath = copyFixture("simple.ts");

      await wrapWorkerWithSentry(
        filePath,
        "my-dsn",
        {
          performance: false,
        },
        false,
      );

      const result = readResult();

      expect(result).toMatchSnapshot();
    });

    it("throws and leaves a file with no default export unchanged", async () => {
      const filePath = copyFixture("no-default-export.ts");
      const originalContent = fs.readFileSync(filePath, "utf-8");

      await expect(
        wrapWorkerWithSentry(
          filePath,
          "my-dsn",
          {
            performance: false,
          },
          false,
        ),
      ).rejects.toThrow("No default export to wrap");

      expect(readResult()).toBe(originalContent);
    });
  });
});
