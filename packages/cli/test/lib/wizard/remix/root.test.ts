import { parseModule } from "magicast";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import {
  wrapAppWithSentry,
  isWithSentryAlreadyUsed,
  instrumentRoot,
} from "../../../../src/lib/wizard/remix/codemods/root.js";

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

vi.mock("../../../../src/lib/wizard/utils/clack/mcp-config.js", () => ({
  offerProjectScopedMcpConfig: vi.fn().mockResolvedValue(undefined),
}));

describe("wrapAppWithSentry", () => {
  it("should wrap the app with Sentry", () => {
    // Empty root.tsx file for testing
    const originalRootAst = parseModule(`
      import { Outlet } from '@remix-run/react';

      export default function App() {
        return <Outlet />;
      }
    `);

    wrapAppWithSentry(originalRootAst, "root.tsx");

    const result = originalRootAst.generate().code;

    expect(result).toMatchInlineSnapshot(`
      "import {withSentry} from '@sentry/remix';
      import { Outlet } from '@remix-run/react';

      function App() {
        return <Outlet />;
      }

      export default withSentry(App);"
    `);
  });
});

describe("isWithSentryAlreadyUsed", () => {
  it("should return false when withSentry is not used", () => {
    const rootAst = parseModule(`
      import { Outlet } from '@remix-run/react';

      export default function App() {
        return <Outlet />;
      }
    `);

    expect(isWithSentryAlreadyUsed(rootAst)).toBe(false);
  });

  it("should return true when withSentry is used in default export", () => {
    const rootAst = parseModule(`
      import { withSentry } from '@sentry/remix';
      import { Outlet } from '@remix-run/react';

      function App() {
        return <Outlet />;
      }

      export default withSentry(App);
    `);

    expect(isWithSentryAlreadyUsed(rootAst)).toBe(true);
  });

  it("should return true when withSentry is used in a variable assignment", () => {
    const rootAst = parseModule(`
      import { withSentry } from '@sentry/remix';
      import { Outlet } from '@remix-run/react';

      function App() {
        return <Outlet />;
      }

      const WrappedApp = withSentry(App);
      export default WrappedApp;
    `);

    expect(isWithSentryAlreadyUsed(rootAst)).toBe(true);
  });

  it("should return true when withSentry is used inside a function", () => {
    const rootAst = parseModule(`
      import { withSentry } from '@sentry/remix';
      import { Outlet } from '@remix-run/react';

      function App() {
        return <Outlet />;
      }

      function createApp() {
        return withSentry(App);
      }

      export default createApp();
    `);

    expect(isWithSentryAlreadyUsed(rootAst)).toBe(true);
  });

  it("should return false when withSentry is imported but not used", () => {
    const rootAst = parseModule(`
      import { withSentry } from '@sentry/remix';
      import { Outlet } from '@remix-run/react';

      export default function App() {
        return <Outlet />;
      }
    `);

    expect(isWithSentryAlreadyUsed(rootAst)).toBe(false);
  });

  it("should return false when a different function with similar name is used", () => {
    const rootAst = parseModule(`
      import { Outlet } from '@remix-run/react';

      function withSentryLike() {
        return null;
      }

      export default function App() {
        withSentryLike();
        return <Outlet />;
      }
    `);

    expect(isWithSentryAlreadyUsed(rootAst)).toBe(false);
  });
});

describe("instrumentRoot", () => {
  const fixturesDir = path.join(__dirname, "fixtures");
  const tmpDir = path.join(fixturesDir, "tmp");

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock process.cwd() to return the fixtures directory
    vi.spyOn(process, "cwd").mockReturnValue(fixturesDir);
  });

  afterEach(() => {
    // Clean up any temporary files
    if (existsSync(tmpDir)) {
      try {
        // Remove files first, then directory
        const appDir = path.join(tmpDir, "app");
        if (existsSync(appDir)) {
          const files = readdirSync(appDir);
          for (const file of files) {
            unlinkSync(path.join(appDir, file));
          }
          rmdirSync(appDir);
        }

        const files = readdirSync(tmpDir);
        for (const file of files) {
          const filePath = path.join(tmpDir, file);
          const stat = statSync(filePath);
          if (stat.isDirectory()) {
            rmdirSync(filePath);
          } else {
            unlinkSync(filePath);
          }
        }
      } catch (error) {
        // Ignore cleanup errors in tests
      }
    }
  });

  it("should add ErrorBoundary and wrap app with Sentry when no ErrorBoundary exists and withSentry is not used", async () => {
    // Copy fixture to tmp directory for testing
    const srcFile = path.join(fixturesDir, "root-no-error-boundary.tsx");
    const appDir = path.join(tmpDir, "app");

    // Create app directory and copy file
    mkdirSync(appDir, { recursive: true });
    copyFileSync(srcFile, path.join(appDir, "root.tsx"));

    // Mock process.cwd() to return tmpDir
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    await instrumentRoot("root.tsx");

    // Check that the file was modified correctly
    const modifiedContent = readFileSync(path.join(appDir, "root.tsx"), "utf8");

    expect(modifiedContent).toContain(
      'import { captureRemixErrorBoundaryError, withSentry } from "@sentry/remix";',
    );
    expect(modifiedContent).toContain(
      "import { Outlet, useRouteError } from '@remix-run/react';",
    );
    expect(modifiedContent).toContain("withSentry(App)");
    expect(modifiedContent).toContain("const ErrorBoundary = () => {");
  });

  it("should wrap app with Sentry when ErrorBoundary exists but no Sentry content", async () => {
    const srcFile = path.join(fixturesDir, "root-with-error-boundary.tsx");
    const appDir = path.join(tmpDir, "app");

    mkdirSync(appDir, { recursive: true });
    copyFileSync(srcFile, path.join(appDir, "root.tsx"));

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    await instrumentRoot("root.tsx");

    const modifiedContent = readFileSync(path.join(appDir, "root.tsx"), "utf8");

    expect(modifiedContent).toContain(
      'import { captureRemixErrorBoundaryError, withSentry } from "@sentry/remix";',
    );
    expect(modifiedContent).toContain("withSentry(App)");
  });

  it("should wrap app with Sentry when ErrorBoundary exists with Sentry content but withSentry is not used", async () => {
    const srcFile = path.join(
      fixturesDir,
      "root-with-sentry-error-boundary.tsx",
    );
    const appDir = path.join(tmpDir, "app");

    mkdirSync(appDir, { recursive: true });
    copyFileSync(srcFile, path.join(appDir, "root.tsx"));

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    await instrumentRoot("root.tsx");

    const modifiedContent = readFileSync(path.join(appDir, "root.tsx"), "utf8");

    expect(modifiedContent).toContain(
      "import { captureRemixErrorBoundaryError, withSentry } from '@sentry/remix';",
    );
    expect(modifiedContent).toContain("withSentry(App)");
  });

  it("should not wrap app when withSentry is already used", async () => {
    const srcFile = path.join(fixturesDir, "root-already-wrapped.tsx");
    const appDir = path.join(tmpDir, "app");

    mkdirSync(appDir, { recursive: true });
    copyFileSync(srcFile, path.join(appDir, "root.tsx"));

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    await instrumentRoot("root.tsx");

    const modifiedContent = readFileSync(path.join(appDir, "root.tsx"), "utf8");

    // Should not add withSentry import or wrap again
    expect(modifiedContent).toContain("withSentry(App)");

    // Count occurrences of withSentry to ensure it's not duplicated
    const withSentryOccurrences = (modifiedContent.match(/withSentry/g) || [])
      .length;
    expect(withSentryOccurrences).toBe(2); // One import, one usage

    // The content should remain largely the same since withSentry is already used
    expect(modifiedContent).toContain("export default withSentry(App)");
  });

  it("should handle ErrorBoundary as variable declaration", async () => {
    const srcFile = path.join(fixturesDir, "root-variable-error-boundary.tsx");
    const appDir = path.join(tmpDir, "app");

    mkdirSync(appDir, { recursive: true });
    copyFileSync(srcFile, path.join(appDir, "root.tsx"));

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    await instrumentRoot("root.tsx");

    const modifiedContent = readFileSync(path.join(appDir, "root.tsx"), "utf8");

    expect(modifiedContent).toContain(
      'import { captureRemixErrorBoundaryError, withSentry } from "@sentry/remix";',
    );
    expect(modifiedContent).toContain("withSentry(App)");
  });
});
