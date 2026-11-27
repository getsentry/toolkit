import { describe, it, expect, vi } from "vitest";
import { generateCode, parseModule } from "magicast";
import { getWithSentryConfigOptionsTemplate } from "../../../../src/lib/wizard/nextjs/templates.js";
import {
  unwrapSentryConfigAst,
  wrapWithSentryConfig,
} from "../../../../src/lib/wizard/nextjs/utils.js";

vi.mock("../../../../src/lib/wizard/utils/clack/mcp-config.js", () => ({
  offerProjectScopedMcpConfig: vi.fn().mockResolvedValue(undefined),
}));

describe("Next.js wizard double wrap prevention", () => {
  const mockWithSentryConfigOptionsTemplate =
    getWithSentryConfigOptionsTemplate({
      orgSlug: "test-org",
      projectSlug: "test-project",
      selfHosted: false,
      sentryUrl: "https://sentry.io",
      tunnelRoute: false,
    });

  describe("unwrapSentryConfigAst utility function", () => {
    describe("AST-based expression unwrapping", () => {
      it("keeps code without withSentryConfig", () => {
        const mod = parseModule("export default nextConfig");
        const originalAST = mod.exports["default"].$ast;
        const resultAST = unwrapSentryConfigAst(originalAST);
        expect(resultAST).toBe(originalAST);
        const { code: exportDefaultCode } = generateCode({ $ast: resultAST });
        expect(exportDefaultCode).toMatchInlineSnapshot(`"nextConfig"`);
      });

      it("should handle plain object literal exports", () => {
        const mod = parseModule(
          `export default { nextConfig: { randomValue: true } }`,
        );
        const originalAST = mod.exports["default"].$ast;
        const resultAST = unwrapSentryConfigAst(originalAST);

        expect(resultAST).toBe(originalAST);
        expect(resultAST.type).toBe("ObjectExpression");
        expect(resultAST).toHaveProperty("properties.length", 1);
      });

      it("should unwrap withSentryConfig with options", () => {
        const mod = parseModule(
          'export default withSentryConfig(nextConfig, { org: "test" })',
        );
        const wrappedAst = mod.exports["default"].$ast;
        const resultAST = unwrapSentryConfigAst(wrappedAst);
        const { code: exportDefaultCode } = generateCode({ $ast: resultAST });

        expect(exportDefaultCode).toMatchInlineSnapshot(`"nextConfig"`);
      });

      it("should unwrap withSentryConfig without options", () => {
        const mod = parseModule("export default withSentryConfig(nextConfig)");
        const wrappedAst = mod.exports["default"].$ast;
        const resultAST = unwrapSentryConfigAst(wrappedAst);
        const { code: exportDefaultCode } = generateCode({ $ast: resultAST });

        expect(exportDefaultCode).toMatchInlineSnapshot(`"nextConfig"`);
      });

      it("should handle nested withSentryConfig calls", () => {
        const mod = parseModule(
          'export default withSentryConfig(withSentryConfig(nextConfig, { org: "inner" }), { org: "outer" })',
        );
        const wrappedAst = mod.exports["default"].$ast;
        const resultAST = unwrapSentryConfigAst(wrappedAst);

        // Should unwrap one level and return the inner withSentryConfig call
        expect(resultAST.type).toBe("CallExpression");
        expect(resultAST).toHaveProperty("callee.name", "withSentryConfig");
        const { code: exportDefaultCode } = generateCode({ $ast: resultAST });

        expect(exportDefaultCode).toMatchInlineSnapshot(
          `"withSentryConfig(nextConfig, { org: "inner" })"`,
        );
      });

      it("should handle complex expressions", () => {
        const mod = parseModule(
          "export default withSentryConfig(someComplexExpression.withMethods())",
        );
        const wrappedAst = mod.exports["default"].$ast;
        const resultAST = unwrapSentryConfigAst(wrappedAst);
        const { code: exportDefaultCode } = generateCode({ $ast: resultAST });

        expect(exportDefaultCode).toMatchInlineSnapshot(
          `"someComplexExpression.withMethods()"`,
        );
      });

      it("should handle object literals", () => {
        const mod = parseModule(
          'export default withSentryConfig({ next: "config", obj: { next: "nested" } }, { org: "test" })',
        );
        const wrappedAst = mod.exports["default"].$ast;
        const resultAST = unwrapSentryConfigAst(wrappedAst);
        const { code: exportDefaultCode } = generateCode({ $ast: resultAST });

        expect(exportDefaultCode).toMatchInlineSnapshot(
          `"{ next: "config", obj: { next: "nested" } }"`,
        );
      });

      it("should return unchanged if not a withSentryConfig call", () => {
        const mod = parseModule("export default someOtherFunction(nextConfig)");
        const originalAST = mod.exports["default"].$ast;
        const resultAST = unwrapSentryConfigAst(originalAST);

        expect(resultAST).toBe(originalAST);
      });
    });
  });

  describe("MJS/TS files", () => {
    it("should unwrap existing withSentryConfig and re-wrap with new config using AST", () => {
      const existingMjsContent = `import { withSentryConfig } from "@sentry/nextjs";

const nextConfig = {};

export default withSentryConfig(nextConfig, {
  org: "old-org",
  project: "old-project",
});`;

      const mod = parseModule(existingMjsContent);
      const originalAST = mod.exports["default"].$ast;
      const unwrappedAst = unwrapSentryConfigAst(originalAST);
      // Verify it returns the first argument (nextConfig identifier)
      expect(unwrappedAst.type).toBe("Identifier");
      expect(unwrappedAst).toHaveProperty("name", "nextConfig");

      // Create a fresh module to simulate the re-wrapping process
      const freshMod =
        parseModule(`import { withSentryConfig } from "@sentry/nextjs";

const nextConfig = {};

export default nextConfig;`);

      // Apply wrapping
      freshMod.exports["default"] = wrapWithSentryConfig(
        freshMod.exports["default"],
        mockWithSentryConfigOptionsTemplate,
      );

      const newCode = freshMod.generate().code;

      // Verify only one withSentryConfig call exists
      const withSentryConfigMatches = newCode.match(/withSentryConfig\s*\(/g);
      expect(withSentryConfigMatches).toHaveLength(1);

      expect(newCode).toContain("test-org");
      expect(newCode).toContain("test-project");
      expect(newCode).not.toContain("old-org");
      expect(newCode).not.toContain("old-project");
    });

    it("should handle complex nested configurations using AST", () => {
      const existingMjsContent = `import { withSentryConfig } from "@sentry/nextjs";

const nextConfig = { experimental: { appDir: true } };

export default withSentryConfig(
  withSentryConfig(nextConfig, { org: "nested-org" }),
  { org: "outer-org" }
);`;

      const mod = parseModule(existingMjsContent);

      // First unwrap ----
      const firstUnwrapAST = unwrapSentryConfigAst(mod.exports["default"].$ast);
      expect(firstUnwrapAST.type).toBe("CallExpression");
      expect(firstUnwrapAST).toHaveProperty("callee.name", "withSentryConfig");

      const { code: exportDefaultCode1 } = generateCode({
        $ast: firstUnwrapAST,
      });
      expect(exportDefaultCode1).toMatchInlineSnapshot(
        `"withSentryConfig(nextConfig, { org: "nested-org" })"`,
      );

      // Second unwrap ----
      const secondUnwrapAST = unwrapSentryConfigAst(firstUnwrapAST);
      expect(secondUnwrapAST.type).toBe("Identifier");
      expect(secondUnwrapAST).toHaveProperty("name", "nextConfig");

      const { code: exportDefaultCode2 } = generateCode({
        $ast: secondUnwrapAST,
      });

      expect(exportDefaultCode2).toMatchInlineSnapshot(`"nextConfig"`);
    });

    it("should handle simple export without existing withSentryConfig using AST", () => {
      const simpleMjsContent = `const nextConfig = {};

export default nextConfig;`;

      const mod = parseModule(simpleMjsContent);
      const originalAST = mod.exports["default"].$ast;
      const unwrappedAst = unwrapSentryConfigAst(originalAST);
      expect(unwrappedAst).toBe(originalAST);
      mod.exports["default"] = wrapWithSentryConfig(
        mod.exports["default"],
        mockWithSentryConfigOptionsTemplate,
      );

      const newCode = mod.generate().code;

      // Should have exactly one withSentryConfig call
      const withSentryConfigMatches = newCode.match(/withSentryConfig\s*\(/g);
      expect(withSentryConfigMatches).toHaveLength(1);

      // Not an inline snapshot: interpolating a shared constant defeats
      // vitest's indentation detection for inline snapshots.
      expect(newCode).toBe(`const nextConfig = {};

export default withSentryConfig(nextConfig, ${sentryOptionsSnapshot});`);
    });

    it("should handle withSentryConfig(nextConfig) without options using AST", () => {
      const existingMjsContent = `import { withSentryConfig } from "@sentry/nextjs";

const nextConfig = {};

export default withSentryConfig(nextConfig);`;

      const mod = parseModule(existingMjsContent);
      const originalAST = mod.exports["default"].$ast;
      const unwrappedAst = unwrapSentryConfigAst(originalAST);
      // Verify it returns the first argument (nextConfig identifier)
      expect(unwrappedAst.type).toBe("Identifier");
      expect(unwrappedAst).toHaveProperty("name", "nextConfig");

      // Simulate the re-wrapping process
      const freshMod =
        parseModule(`import { withSentryConfig } from "@sentry/nextjs";

const nextConfig = {};

export default nextConfig;`);
      freshMod.exports["default"] = wrapWithSentryConfig(
        freshMod.exports["default"],
        mockWithSentryConfigOptionsTemplate,
      );

      const newCode = freshMod.generate().code;

      // Should have exactly one withSentryConfig call
      const withSentryConfigMatches = newCode.match(/withSentryConfig\s*\(/g);
      expect(withSentryConfigMatches).toHaveLength(1);

      expect(newCode).not.toContain("withSentryConfig(withSentryConfig(");
      expect(newCode).toMatch(/withSentryConfig\s*\(\s*nextConfig\s*,/);
    });
  });
});

const sentryOptionsSnapshot = `{
  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/sourcemaps/uploading/bundler-plugin-options/

  org: "test-org",

  project: "test-project",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  }
}`;
