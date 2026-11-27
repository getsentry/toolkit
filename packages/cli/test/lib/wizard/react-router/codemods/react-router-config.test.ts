import { existsSync, promises } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@clack/prompts";
import {
  getReactRouterConfigFilename,
  instrumentReactRouterConfig,
} from "../../../../../src/lib/wizard/react-router/codemods/react-router-config.js";
import { configureReactRouterConfig } from "../../../../../src/lib/wizard/react-router/sdk-setup.js";

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

    it.each([
      [true, [], "react-router.config.ts"],
      [false, [], "react-router.config.js"],
      [true, ["react-router.config.js"], "react-router.config.js"],
      [false, ["react-router.config.ts"], "react-router.config.ts"],
      [
        true,
        ["react-router.config.ts", "react-router.config.js"],
        "react-router.config.ts",
      ],
    ])(
      "getReactRouterConfigFilename(isTS: %s) with %j picks %s",
      (isTS, existing, expected) => {
        vi.mocked(existsSync).mockImplementation((filePath) =>
          existing.some((name) => filePath === path.join(mockCwd, name)),
        );

        expect(getReactRouterConfigFilename(isTS)).toBe(expected);
      },
    );

    it("names the existing .js config when configuring a TypeScript project", async () => {
      vi.mocked(existsSync).mockImplementation(
        (filePath) => filePath === path.join(mockCwd, "react-router.config.js"),
      );
      vi.mocked(promises.readFile).mockResolvedValue(
        "export default {\n  ssr: true,\n};\n",
      );
      vi.mocked(promises.writeFile).mockResolvedValue();

      await configureReactRouterConfig(true, "@sentry/react-router");

      expect(log.success).toHaveBeenCalledWith(
        expect.stringContaining("react-router.config.js"),
      );
      expect(log.success).not.toHaveBeenCalledWith(
        expect.stringContaining("react-router.config.ts"),
      );
    });

    it("updates an existing react-router.config.js in a TypeScript project", async () => {
      const writtenFiles: Record<string, string> = {};
      vi.mocked(existsSync).mockImplementation(
        (filePath) => filePath === path.join(mockCwd, "react-router.config.js"),
      );
      vi.mocked(promises.readFile).mockResolvedValue(
        "export default {\n  ssr: true,\n};\n",
      );
      vi.mocked(promises.writeFile).mockImplementation((filePath, content) => {
        writtenFiles[filePath as string] = content as string;
        return Promise.resolve();
      });

      await instrumentReactRouterConfig(true);

      expect(Object.keys(writtenFiles)).toEqual([
        path.join(mockCwd, "react-router.config.js"),
      ]);
      expect(
        writtenFiles[path.join(mockCwd, "react-router.config.js")],
      ).toContain("sentryOnBuildEnd");
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

    it('flips a quoted "ssr": false instead of adding a second key', async () => {
      const existingConfig = `export default {
  "ssr": false
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
      expect(writtenConfig).not.toContain("false");
      expect(writtenConfig?.match(/ssr/g)).toHaveLength(1);
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

    it("throws when buildEnd already exists as a method", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(promises.readFile).mockResolvedValue(
        "export default {\n  ssr: true,\n  async buildEnd() {\n    await upload();\n  },\n};\n",
      );
      vi.mocked(promises.writeFile).mockResolvedValue();

      await expect(instrumentReactRouterConfig(true)).rejects.toThrow(
        "A buildEnd hook already exists",
      );
      expect(promises.writeFile).not.toHaveBeenCalled();
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
