import { existsSync, promises } from "node:fs";
import type { namedTypes as t } from "ast-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addReactRouterPluginToViteConfig,
  instrumentViteConfig,
} from "../../../../../src/lib/wizard/react-router/codemods/vite.js";

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
  },
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      writeFile: vi.fn(),
    },
  };
});

describe("Vite Config Instrumentation", () => {
  const mockCwd = "/mock/project";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("instrumentViteConfig", () => {
    it("imports sentryReactRouter from the given path and keeps the package name in optimizeDeps.exclude", async () => {
      const writtenFiles: Record<string, string> = {};
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(
        `import { defineConfig } from 'vite';

export default defineConfig({
  plugins: []
});`,
      );
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      await instrumentViteConfig(
        "my-org",
        "my-project",
        "@sentry/react-router/vite",
      );

      const written = Object.values(writtenFiles)[0];
      expect(written).toContain(
        'import { sentryReactRouter } from "@sentry/react-router/vite";',
      );
      expect(written).not.toContain('from "@sentry/react-router";');
      expect(written).toMatch(
        /exclude:\s*\[\s*["']@sentry\/react-router["']\s*\]/,
      );
    });

    it("should throw error if vite config file does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(
        instrumentViteConfig("my-org", "my-project"),
      ).rejects.toThrow("Could not find vite.config.ts or vite.config.js");
    });

    it("should detect and skip if Sentry content already exists", async () => {
      const existingConfig = `import { defineConfig } from 'vite';
import { sentryReactRouter } from '@sentry/react-router';

export default defineConfig({
  plugins: [sentryReactRouter({ org: "my-org", project: "my-project" }, config)]
});`;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(existingConfig);

      const result = await instrumentViteConfig("my-org", "my-project");

      expect(result.wasConverted).toBe(false);
    });

    it("should add sentryReactRouter plugin and convert to function form", async () => {
      const simpleConfig = `import { defineConfig } from 'vite';

export default defineConfig({
  plugins: []
});`;

      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(simpleConfig);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentViteConfig("my-org", "my-project");

      expect(result.wasConverted).toBe(true);

      const writtenConfig = Object.values(writtenFiles)[0];
      expect(writtenConfig).toContain("sentryReactRouter");
      expect(writtenConfig).toContain('org: "my-org"');
      expect(writtenConfig).toContain('project: "my-project"');
      expect(writtenConfig).toContain("config =>");
      expect(writtenConfig).toContain("optimizeDeps");
      expect(writtenConfig).toMatch(/exclude.*@sentry\/react-router/s);
    });

    it("should work with existing function form", async () => {
      const functionConfig = `import { defineConfig } from 'vite';

export default defineConfig(config => ({
  plugins: []
}));`;

      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(functionConfig);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentViteConfig("my-org", "my-project");

      expect(result.wasConverted).toBe(false);

      const writtenConfig = Object.values(writtenFiles)[0];
      expect(writtenConfig).toContain("sentryReactRouter");
      expect(writtenConfig).toContain('org: "my-org"');
      expect(writtenConfig).toContain('project: "my-project"');
      expect(writtenConfig).toContain("optimizeDeps");
      expect(writtenConfig).toMatch(/exclude.*@sentry\/react-router/s);
    });

    it("should add @sentry/react-router to existing optimizeDeps.exclude", async () => {
      const configWithExistingExclude = `import { defineConfig } from 'vite';

export default defineConfig(config => ({
  plugins: [],
  optimizeDeps: {
    exclude: ["some-other-package"],
  },
}));`;

      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(configWithExistingExclude);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentViteConfig("my-org", "my-project");

      expect(result.wasConverted).toBe(false);

      const writtenConfig = Object.values(writtenFiles)[0];
      expect(writtenConfig).toContain("sentryReactRouter");
      expect(writtenConfig).toContain("some-other-package");
      expect(writtenConfig).toMatch(/exclude.*@sentry\/react-router/s);
    });

    it("should not duplicate exclude entry on repeated calls", async () => {
      const configContent = `import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
});`;

      const { parseModule, generateCode } = await import("magicast");
      const mod = parseModule(configContent);
      const program = mod.$ast as t.Program;

      addReactRouterPluginToViteConfig(program, "my-org", "my-project");
      addReactRouterPluginToViteConfig(program, "my-org", "my-project");

      const output = generateCode(mod).code;
      const excludeMatches =
        output.match(/exclude.*@sentry\/react-router/gs) ?? [];
      expect(excludeMatches).toHaveLength(1);
    });

    it("should skip non-object optimizeDeps", async () => {
      const configWithFunctionOptimizeDeps = `import { defineConfig } from 'vite';
import { getOptimizeDeps } from './config-utils';

export default defineConfig(config => ({
  plugins: [],
  optimizeDeps: getOptimizeDeps(),
}));`;

      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(
        configWithFunctionOptimizeDeps,
      );
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentViteConfig("my-org", "my-project");

      expect(result.wasConverted).toBe(false);

      const writtenConfig = Object.values(writtenFiles)[0];
      expect(writtenConfig).toContain("sentryReactRouter");
      expect(writtenConfig).toContain("getOptimizeDeps()");
    });

    it("should skip non-array optimizeDeps.exclude", async () => {
      const configWithFunctionExclude = `import { defineConfig } from 'vite';
import { getExcludes } from './config-utils';

export default defineConfig(config => ({
  plugins: [],
  optimizeDeps: {
    exclude: getExcludes(),
  },
}));`;

      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(configWithFunctionExclude);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentViteConfig("my-org", "my-project");

      expect(result.wasConverted).toBe(false);

      const writtenConfig = Object.values(writtenFiles)[0];
      expect(writtenConfig).toContain("sentryReactRouter");
      expect(writtenConfig).toContain("getExcludes()");
      expect(writtenConfig).not.toMatch(/exclude.*@sentry\/react-router/s);
    });

    it("should prefer vite.config.ts over vite.config.js", async () => {
      const configContent = `import { defineConfig } from 'vite';
export default defineConfig({ plugins: [] });`;

      const writtenFiles: Record<string, string> = {};

      // First call checks for vite.config.ts (returns true), second call validates it exists
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(configContent);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      await instrumentViteConfig("my-org", "my-project");

      // Should write to vite.config.ts, not vite.config.js
      const writtenPath = Object.keys(writtenFiles)[0];
      expect(writtenPath).toContain("vite.config.ts");
      expect(writtenPath).not.toContain("vite.config.js");
    });

    it("should work with function expression form", async () => {
      const functionConfig = `import { defineConfig } from 'vite';

export default defineConfig(function(config) {
  return {
    plugins: []
  };
});`;

      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(functionConfig);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentViteConfig("my-org", "my-project");

      expect(result.wasConverted).toBe(false);

      const writtenConfig = Object.values(writtenFiles)[0];
      expect(writtenConfig).toContain("sentryReactRouter");
      expect(writtenConfig).toContain('org: "my-org"');
      expect(writtenConfig).toContain('project: "my-project"');
      expect(writtenConfig).toContain("optimizeDeps");
      expect(writtenConfig).toMatch(/exclude.*@sentry\/react-router/s);
    });
  });
});
