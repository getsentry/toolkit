import { beforeEach, describe, it, vi, expect, afterEach } from "vitest";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as path from "node:path";

import {
  findInstalledPackageFromList,
  hasPackageInstalled,
  getPackageVersion,
  type PackageDotJson,
} from "../../../../src/lib/wizard/utils/package-json.js";

const { mockedFs, mockedClack } = vi.hoisted(() => {
  return {
    mockedFs: {
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
    },
    mockedClack: {
      log: {
        error: vi.fn(),
      },
    },
  };
});

vi.mock(import("node:fs"), async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: mockedFs.existsSync,
  readFileSync: mockedFs.readFileSync,
}));

vi.mock(import("@clack/prompts"), async (importOriginal) => ({
  ...(await importOriginal()),
  log: {
    ...(await importOriginal()).log,
    error: mockedClack.log.error,
  },
}));

describe("package-json utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPackageVersion", () => {
    it("returns version from dependencies", () => {
      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "^7.0.0",
        },
      };

      expect(getPackageVersion("@sentry/node", packageJson)).toBe("^7.0.0");
    });

    it("returns version from devDependencies", () => {
      const packageJson: PackageDotJson = {
        devDependencies: {
          "@sentry/cli": "^2.0.0",
        },
      };

      expect(getPackageVersion("@sentry/cli", packageJson)).toBe("^2.0.0");
    });

    it("prioritizes dependencies over devDependencies", () => {
      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "^7.0.0",
        },
        devDependencies: {
          "@sentry/node": "^6.0.0",
        },
      };

      expect(getPackageVersion("@sentry/node", packageJson)).toBe("^7.0.0");
    });

    it("returns undefined if package is not found", () => {
      const packageJson: PackageDotJson = {
        dependencies: {},
      };

      expect(getPackageVersion("@sentry/node", packageJson)).toBeUndefined();
    });

    it("returns undefined if packageJson has no dependencies", () => {
      const packageJson: PackageDotJson = {};

      expect(getPackageVersion("@sentry/node", packageJson)).toBeUndefined();
    });

    describe("pnpm catalog resolution", () => {
      beforeEach(() => {
        vi.spyOn(process, "cwd").mockReturnValue(
          "/test/workspace/packages/app",
        );
      });

      afterEach(() => {
        vi.clearAllMocks();
      });

      it("resolves default catalog reference", () => {
        mockedFs.existsSync.mockImplementation((filepath: string) => {
          return (
            filepath === path.join("/test/workspace", "pnpm-workspace.yaml")
          );
        });

        mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sentry/node': ^7.100.0
  '@sentry/react': ^7.100.0
`);

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/node": "catalog:",
          },
        };

        expect(getPackageVersion("@sentry/node", packageJson)).toBe("^7.100.0");
      });

      it("resolves named catalog reference", () => {
        mockedFs.existsSync.mockImplementation((filepath: string) => {
          return (
            filepath === path.join("/test/workspace", "pnpm-workspace.yaml")
          );
        });

        mockedFs.readFileSync.mockReturnValue(`
catalogs:
  sveltekit:
    '@sentry/sveltekit': ^7.100.0
    '@sentry/node': ^7.100.0
`);

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/sveltekit": "catalog:sveltekit",
          },
        };

        expect(getPackageVersion("@sentry/sveltekit", packageJson)).toBe(
          "^7.100.0",
        );
      });

      it("searches parent directories for pnpm-workspace.yaml", () => {
        const mockCwd = "/test/workspace/packages/app/src";
        vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

        mockedFs.existsSync.mockImplementation((filepath: string) => {
          return (
            filepath === path.join("/test/workspace", "pnpm-workspace.yaml")
          );
        });

        mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sentry/node': ^7.100.0
`);

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/node": "catalog:",
          },
        };

        expect(getPackageVersion("@sentry/node", packageJson)).toBe("^7.100.0");
      });

      it("returns undefined if catalog does not contain the package", () => {
        mockedFs.existsSync.mockImplementation((filepath: string) => {
          return (
            filepath === path.join("/test/workspace", "pnpm-workspace.yaml")
          );
        });

        mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sentry/react': ^7.100.0
`);

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/node": "catalog:",
          },
        };

        expect(getPackageVersion("@sentry/node", packageJson)).toBeUndefined();
      });

      it("returns undefined if named catalog does not exist", () => {
        mockedFs.existsSync.mockImplementation((filepath: string) => {
          return (
            filepath === path.join("/test/workspace", "pnpm-workspace.yaml")
          );
        });

        mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sentry/node': ^7.100.0
`);

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/sveltekit": "catalog:sveltekit",
          },
        };

        expect(
          getPackageVersion("@sentry/sveltekit", packageJson),
        ).toBeUndefined();
      });

      it("returns undefined if pnpm-workspace.yaml is not found", () => {
        mockedFs.existsSync.mockReturnValue(false);

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/node": "catalog:",
          },
        };

        expect(getPackageVersion("@sentry/node", packageJson)).toBeUndefined();
        expect(mockedClack.log.error).toHaveBeenCalledWith(
          "Could not find pnpm-workspace.yaml.",
        );
      });

      it("stops searching at root directory", () => {
        const mockCwd = "/test";
        vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

        mockedFs.existsSync.mockReturnValue(false);

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/node": "catalog:",
          },
        };

        expect(getPackageVersion("@sentry/node", packageJson)).toBeUndefined();
      });

      it("handles both default catalog and named catalogs together", () => {
        mockedFs.existsSync.mockImplementation((filepath: string) => {
          return (
            filepath === path.join("/test/workspace", "pnpm-workspace.yaml")
          );
        });

        mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sentry/node': ^7.100.0
catalogs:
  sveltekit:
    '@sentry/sveltekit': ^7.200.0
`);

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/node": "catalog:",
            "@sentry/sveltekit": "catalog:sveltekit",
          },
        };

        expect(getPackageVersion("@sentry/node", packageJson)).toBe("^7.100.0");
        expect(getPackageVersion("@sentry/sveltekit", packageJson)).toBe(
          "^7.200.0",
        );
      });

      it("handles the correct catalog namespace", () => {
        mockedFs.existsSync.mockImplementation((filepath: string) => {
          return (
            filepath === path.join("/test/workspace", "pnpm-workspace.yaml")
          );
        });

        mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sveltejs/kit': ^1.0.0
catalogs:
  sveltekit:
    '@sveltejs/kit': ^2.31.0
`);

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sveltejs/kit": "catalog:sveltekit",
          },
        };

        expect(getPackageVersion("@sveltejs/kit", packageJson)).toBe("^2.31.0");
      });

      it("ignores pnpm-workspace.yaml content that is not a catalog mapping", () => {
        mockedFs.existsSync.mockImplementation((filepath: string) => {
          return (
            filepath === path.join("/test/workspace", "pnpm-workspace.yaml")
          );
        });

        mockedFs.readFileSync.mockReturnValue("invalid: yaml: content: [");

        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/node": "catalog:",
          },
        };

        expect(getPackageVersion("@sentry/node", packageJson)).toBeUndefined();
      });

      it("reads quoted names, inline comments, and catalogs of other packages", () => {
        mockedFs.existsSync.mockImplementation((filepath: string) => {
          return (
            filepath === path.join("/test/workspace", "pnpm-workspace.yaml")
          );
        });

        mockedFs.readFileSync.mockReturnValue(`packages:
  - 'apps/*'

# Versions shared across the workspace
catalog:
  "@sentry/node": "^8.0.0" # keep in sync
  react: ^18.2.0

catalogs:
  legacy:
    '@sentry/node': ~7.120.0
  next:
    "@sentry/nextjs": 9.0.0
onlyBuiltDependencies:
  - esbuild
`);

        expect(
          getPackageVersion("@sentry/node", {
            dependencies: { "@sentry/node": "catalog:" },
          }),
        ).toBe("^8.0.0");
        expect(
          getPackageVersion("@sentry/node", {
            dependencies: { "@sentry/node": "catalog:legacy" },
          }),
        ).toBe("~7.120.0");
        expect(
          getPackageVersion("@sentry/nextjs", {
            dependencies: { "@sentry/nextjs": "catalog:next" },
          }),
        ).toBe("9.0.0");
      });

      it("handles regular version strings without catalog lookup", () => {
        const packageJson: PackageDotJson = {
          dependencies: {
            "@sentry/node": "^7.0.0",
            "@sentry/react": "~7.1.0",
            "@sentry/cli": "2.0.0",
          },
        };

        expect(getPackageVersion("@sentry/node", packageJson)).toBe("^7.0.0");
        expect(getPackageVersion("@sentry/react", packageJson)).toBe("~7.1.0");
        expect(getPackageVersion("@sentry/cli", packageJson)).toBe("2.0.0");
        expect(mockedFs.existsSync).not.toHaveBeenCalled();
      });
    });
  });

  describe("hasPackageInstalled", () => {
    it("returns true if package is in dependencies", () => {
      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "^7.0.0",
        },
      };

      expect(hasPackageInstalled("@sentry/node", packageJson)).toBe(true);
    });

    it("returns true if package is in devDependencies", () => {
      const packageJson: PackageDotJson = {
        devDependencies: {
          "@sentry/cli": "^2.0.0",
        },
      };

      expect(hasPackageInstalled("@sentry/cli", packageJson)).toBe(true);
    });

    it("returns false if package is not installed", () => {
      const packageJson: PackageDotJson = {
        dependencies: {},
      };

      expect(hasPackageInstalled("@sentry/node", packageJson)).toBe(false);
    });

    it("returns true if package uses catalog reference", () => {
      const mockCwd = "/test/workspace/packages/app";
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

      mockedFs.existsSync.mockImplementation((filepath: string) => {
        return filepath === path.join("/test/workspace", "pnpm-workspace.yaml");
      });

      mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sentry/node': ^7.100.0
`);

      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "catalog:",
        },
      };

      expect(hasPackageInstalled("@sentry/node", packageJson)).toBe(true);
    });

    it("returns false if package uses catalog reference but catalog does not have it", () => {
      const mockCwd = "/test/workspace/packages/app";
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

      mockedFs.existsSync.mockImplementation((filepath: string) => {
        return filepath === path.join("/test/workspace", "pnpm-workspace.yaml");
      });

      mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sentry/react': ^7.100.0
`);

      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "catalog:",
        },
      };

      expect(hasPackageInstalled("@sentry/node", packageJson)).toBe(false);
    });
  });

  describe("findInstalledPackageFromList", () => {
    it("returns the first installed package from the list", () => {
      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "^7.0.0",
        },
      };

      const result = findInstalledPackageFromList(
        ["@sentry/cli", "@sentry/node", "@sentry/react"],
        packageJson,
      );

      expect(result).toEqual({
        name: "@sentry/node",
        version: "^7.0.0",
      });
    });

    it("returns undefined if no packages are installed", () => {
      const packageJson: PackageDotJson = {
        dependencies: {},
      };

      const result = findInstalledPackageFromList(
        ["@sentry/cli", "@sentry/node", "@sentry/react"],
        packageJson,
      );

      expect(result).toBeUndefined();
    });

    it("checks both dependencies and devDependencies", () => {
      const packageJson: PackageDotJson = {
        devDependencies: {
          "@sentry/cli": "^2.0.0",
        },
      };

      const result = findInstalledPackageFromList(
        ["@sentry/node", "@sentry/cli"],
        packageJson,
      );

      expect(result).toEqual({
        name: "@sentry/cli",
        version: "^2.0.0",
      });
    });

    it("returns first match in order provided", () => {
      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "^7.0.0",
          "@sentry/react": "^7.0.0",
        },
      };

      const result = findInstalledPackageFromList(
        ["@sentry/react", "@sentry/node"],
        packageJson,
      );

      expect(result).toEqual({
        name: "@sentry/react",
        version: "^7.0.0",
      });
    });

    it("works with catalog references", () => {
      const mockCwd = "/test/workspace/packages/app";
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

      mockedFs.existsSync.mockImplementation((filepath: string) => {
        return filepath === path.join("/test/workspace", "pnpm-workspace.yaml");
      });

      mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sentry/node': ^7.100.0
`);

      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "catalog:",
        },
      };

      const result = findInstalledPackageFromList(
        ["@sentry/cli", "@sentry/node"],
        packageJson,
      );

      expect(result).toEqual({
        name: "@sentry/node",
        version: "^7.100.0",
      });
    });

    it("returns undefined for empty package list", () => {
      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "^7.0.0",
        },
      };

      const result = findInstalledPackageFromList([], packageJson);

      expect(result).toBeUndefined();
    });

    it("skips packages with unresolvable catalog references", () => {
      const mockCwd = "/test/workspace/packages/app";
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

      mockedFs.existsSync.mockImplementation((filepath: string) => {
        return filepath === path.join("/test/workspace", "pnpm-workspace.yaml");
      });

      mockedFs.readFileSync.mockReturnValue(`
catalog:
  '@sentry/react': ^7.100.0
`);

      const packageJson: PackageDotJson = {
        dependencies: {
          "@sentry/node": "catalog:",
          "@sentry/react": "catalog:",
        },
      };

      const result = findInstalledPackageFromList(
        ["@sentry/node", "@sentry/react"],
        packageJson,
      );

      // Should skip @sentry/node (unresolvable) and return @sentry/react
      expect(result).toEqual({
        name: "@sentry/react",
        version: "^7.100.0",
      });
    });
  });
});
