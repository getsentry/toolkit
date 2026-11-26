import { existsSync, promises } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instrumentReactRouterConfig } from "../../../../../src/lib/wizard/react-router/codemods/react-router-config.js";

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

describe("React Router Config File Instrumentation", () => {
  const mockCwd = "/mock/project";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("instrumentReactRouterConfig", () => {
    it("imports sentryOnBuildEnd from the given path when creating the config", async () => {
      const writtenFiles: Record<string, string> = {};
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      await instrumentReactRouterConfig(true, "@sentry/react-router/vite");

      const written = Object.values(writtenFiles)[0];
      expect(written).toContain(
        'import { sentryOnBuildEnd } from "@sentry/react-router/vite";',
      );
      expect(written).not.toContain('from "@sentry/react-router";');
    });

    it("imports sentryOnBuildEnd from the given path when modifying an existing config", async () => {
      const writtenFiles: Record<string, string> = {};
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(
        `import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
} satisfies Config;
`,
      );
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      await instrumentReactRouterConfig(true, "@sentry/react-router/vite");

      const written = Object.values(writtenFiles)[0];
      expect(written).toContain('from "@sentry/react-router/vite"');
      expect(written).toContain("sentryOnBuildEnd");
      expect(written).not.toContain('from "@sentry/react-router";');
    });

    it("should create new config file if it does not exist", async () => {
      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentReactRouterConfig(true);

      expect(result.ssrWasChanged).toBe(false);

      const configPath = path.join(mockCwd, "react-router.config.ts");
      expect(writtenFiles[configPath]).toContain("ssr: true");
      expect(writtenFiles[configPath]).toContain("sentryOnBuildEnd");
      expect(writtenFiles[configPath]).toContain("buildEnd:");
    });

    it("should create .js config when TypeScript is not used", async () => {
      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      await instrumentReactRouterConfig(false);

      const configPath = path.join(mockCwd, "react-router.config.js");
      expect(writtenFiles[configPath]).toBeDefined();
      // Verify JS config doesn't have TypeScript-only syntax
      expect(writtenFiles[configPath]).not.toContain("import type");
      expect(writtenFiles[configPath]).not.toContain("satisfies Config");
      expect(writtenFiles[configPath]).toContain("sentryOnBuildEnd");
      expect(writtenFiles[configPath]).toContain("buildEnd:");
    });

    it("should detect and skip if Sentry content already exists", async () => {
      const existingConfig = `import { sentryOnBuildEnd } from '@sentry/react-router';

export default {
  ssr: true,
  buildEnd: async ({ viteConfig, reactRouterConfig, buildManifest }) => {
    await sentryOnBuildEnd({ viteConfig, reactRouterConfig, buildManifest });
  }
};`;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(existingConfig);

      const result = await instrumentReactRouterConfig(true);

      expect(result.ssrWasChanged).toBe(false);
    });

    it("should add buildEnd hook to existing config", async () => {
      const existingConfig = `export default {
  ssr: true,
  async: false
};`;

      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(existingConfig);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentReactRouterConfig(true);

      expect(result.ssrWasChanged).toBe(false);

      const writtenConfig = Object.values(writtenFiles)[0];
      expect(writtenConfig).toContain("sentryOnBuildEnd");
      expect(writtenConfig).toContain("buildEnd:");
    });

    it("should set ssr: true if missing", async () => {
      const existingConfig = `export default {
  async: false
};`;

      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(existingConfig);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentReactRouterConfig(true);

      expect(result.ssrWasChanged).toBe(true);

      const writtenConfig = Object.values(writtenFiles)[0];
      expect(writtenConfig).toContain("ssr: true");
    });

    it("should report ssrWasChanged when changing ssr from false to true", async () => {
      const existingConfig = `export default {
  ssr: false
};`;

      const writtenFiles: Record<string, string> = {};

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(existingConfig);
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      const result = await instrumentReactRouterConfig(true);

      expect(result.ssrWasChanged).toBe(true);

      const writtenConfig = Object.values(writtenFiles)[0];
      expect(writtenConfig).toContain("ssr: true");
    });

    it("should throw error if buildEnd already exists", async () => {
      const existingConfig = `export default {
  ssr: true,
  buildEnd: async () => {
    console.log('existing hook');
  }
};`;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(existingConfig);

      await expect(instrumentReactRouterConfig(true)).rejects.toThrow(
        "A buildEnd hook already exists",
      );
    });
  });
});
