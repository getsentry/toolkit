/**
 * Tests for the `sentry init` command entry point.
 *
 * Uses spyOn on the wizard-runner and projects API namespaces to
 * capture runWizard calls and mock findProjectsBySlug without
 * mock.module (which leaks across test files).
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initCommand } from "../../src/commands/init.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as projectsApi from "../../src/lib/api/projects.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as authModule from "../../src/lib/db/auth.js";
import {
  AuthError,
  ContextError,
  ValidationError,
} from "../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as prefetchNs from "../../src/lib/init/org-prefetch.js";
import { resetPrefetch } from "../../src/lib/init/org-prefetch.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as wizardRunner from "../../src/lib/init/wizard-runner.js";

/** Minimal org shape for mock returns */
const MOCK_ORG = { id: "1", slug: "resolved-org", name: "Resolved Org" };

/** Minimal project-with-org shape for mock returns */
function mockProject(slug: string, orgSlug = "resolved-org") {
  return { slug, orgSlug, id: "123", name: slug };
}

let capturedArgs: Record<string, unknown> | undefined;
let runWizardSpy: ReturnType<typeof spyOn>;
let findProjectsSpy: ReturnType<typeof spyOn>;
let listProjectsSpy: ReturnType<typeof spyOn>;
let warmSpy: ReturnType<typeof spyOn>;
let refreshTokenSpy: ReturnType<typeof spyOn>;

const func = (await initCommand.loader()) as unknown as (
  this: {
    cwd: string;
    stdout: { write: () => boolean; isTTY?: boolean };
    stderr: { write: () => boolean };
    stdin: { isTTY?: boolean };
  },
  flags: Record<string, unknown>,
  first?: string,
  second?: string
) => Promise<void>;

function makeContext(
  cwd = "/projects/app",
  tty: { stdinTTY?: boolean; stdoutTTY?: boolean } = {}
) {
  return {
    cwd,
    stdout: { write: () => true, isTTY: tty.stdoutTTY ?? true },
    stderr: { write: () => true },
    stdin: { isTTY: tty.stdinTTY ?? true },
  };
}

const DEFAULT_FLAGS = { yes: true, "dry-run": false } as const;

beforeEach(() => {
  capturedArgs = undefined;
  resetPrefetch();
  runWizardSpy = vi
    .spyOn(wizardRunner, "runWizard")
    .mockImplementation((args: Record<string, unknown>) => {
      capturedArgs = args;
      return Promise.resolve();
    });
  // Default: mock findProjectsBySlug to return a single project match
  findProjectsSpy = vi
    .spyOn(projectsApi, "findProjectsBySlug")
    .mockImplementation(async (slug: string) => ({
      projects: [mockProject(slug)],
      orgs: [MOCK_ORG],
    }));
  listProjectsSpy = vi.spyOn(projectsApi, "listProjects").mockResolvedValue([]);
  // Spy on warmOrgDetection to verify it's called/skipped appropriately.
  // The mock prevents real DSN scans and API calls from the background.
  warmSpy = vi.spyOn(prefetchNs, "warmOrgDetection").mockImplementation(
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op mock
    () => {}
  );
  refreshTokenSpy = vi
    .spyOn(authModule, "refreshToken")
    .mockResolvedValue({ token: "oauth-token", refreshed: false });
});

afterEach(() => {
  runWizardSpy.mockRestore();
  findProjectsSpy.mockRestore();
  listProjectsSpy.mockRestore();
  warmSpy.mockRestore();
  refreshTokenSpy.mockRestore();
  resetPrefetch();
});

describe("init command func", () => {
  // ── Features parsing ──────────────────────────────────────────────────

  describe("features parsing", () => {
    test("splits comma-separated features", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors,tracing,logs"],
      });
      expect(capturedArgs?.features).toEqual([
        "errorMonitoring",
        "performanceMonitoring",
        "logs",
      ]);
    });

    test("splits plus-separated features", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors+tracing+logs"],
      });
      expect(capturedArgs?.features).toEqual([
        "errorMonitoring",
        "performanceMonitoring",
        "logs",
      ]);
    });

    test("splits space-separated features", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors tracing logs"],
      });
      expect(capturedArgs?.features).toEqual([
        "errorMonitoring",
        "performanceMonitoring",
        "logs",
      ]);
    });

    test("merges multiple --features flags", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors,tracing", "logs"],
      });
      expect(capturedArgs?.features).toEqual([
        "errorMonitoring",
        "performanceMonitoring",
        "logs",
      ]);
    });

    test("trims whitespace from features", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: [" errors , tracing "],
      });
      expect(capturedArgs?.features).toEqual([
        "errorMonitoring",
        "performanceMonitoring",
      ]);
    });

    test("filters empty segments", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors,,tracing,"],
      });
      expect(capturedArgs?.features).toEqual([
        "errorMonitoring",
        "performanceMonitoring",
      ]);
    });

    test("normalizes public aliases to wizard feature ids", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors,tracing,replay,agent-tracing,mcp-observability"],
      });
      expect(capturedArgs?.features).toEqual([
        "errorMonitoring",
        "performanceMonitoring",
        "sessionReplay",
        "aiMonitoring",
        "mcpObservability",
      ]);
    });

    test("accepts canonical wizard feature ids", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: [
          "errorMonitoring,performanceMonitoring,sessionReplay,aiMonitoring,mcpObservability",
        ],
      });
      expect(capturedArgs?.features).toEqual([
        "errorMonitoring",
        "performanceMonitoring",
        "sessionReplay",
        "aiMonitoring",
        "mcpObservability",
      ]);
    });

    test("throws ValidationError for unknown features", async () => {
      const ctx = makeContext();
      const promise = func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors,unknownFeature"],
      });
      await expect(promise).rejects.toThrow(ValidationError);
      await expect(promise).rejects.toThrow(
        "Supported features: errors, tracing, logs, replay, profiling, crons, agent-tracing, mcp-observability"
      );
      expect(runWizardSpy).not.toHaveBeenCalled();
      expect(findProjectsSpy).not.toHaveBeenCalled();
      expect(warmSpy).not.toHaveBeenCalled();
    });

    test.each([
      "user-feedback",
      "userFeedback",
    ])("rejects %s because init cannot configure User Feedback placement", async (feature) => {
      const ctx = makeContext();
      const promise = func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: [feature],
      });
      await expect(promise).rejects.toThrow(ValidationError);
      await expect(promise).rejects.toThrow(
        `Unknown init feature "${feature}"`
      );
      expect(runWizardSpy).not.toHaveBeenCalled();
    });

    test.each([
      "metrics",
      "sourcemaps",
      "attachments",
    ])("rejects %s because init does not yet automate its setup", async (feature) => {
      const ctx = makeContext();
      const promise = func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: [feature],
      });
      await expect(promise).rejects.toThrow(ValidationError);
      await expect(promise).rejects.toThrow(
        `Unknown init feature "${feature}"`
      );
      expect(runWizardSpy).not.toHaveBeenCalled();
    });

    test("passes undefined when features not provided", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS);
      expect(capturedArgs?.features).toBeUndefined();
    });
  });

  // ── Non-TTY validation ───────────────────────────────────────────────

  describe("non-TTY validation", () => {
    test("requires --yes before project lookup or wizard startup", async () => {
      const ctx = makeContext("/projects/app", { stdinTTY: false });
      await expect(
        func.call(ctx, { yes: false, "dry-run": false }, "my-app")
      ).rejects.toThrow(ContextError);
      expect(findProjectsSpy).not.toHaveBeenCalled();
      expect(warmSpy).not.toHaveBeenCalled();
      expect(runWizardSpy).not.toHaveBeenCalled();
    });

    test("requires explicit features with --yes", async () => {
      const ctx = makeContext("/projects/app", { stdoutTTY: false });
      const promise = func.call(ctx, DEFAULT_FLAGS);
      await expect(promise).rejects.toThrow(ContextError);
      await expect(promise).rejects.toThrow(
        "sentry init --yes --features errors,tracing,replay [target] [directory]"
      );
      expect(warmSpy).not.toHaveBeenCalled();
      expect(runWizardSpy).not.toHaveBeenCalled();
    });

    test("runs when --yes and --features are both provided", async () => {
      const ctx = makeContext("/projects/app", { stdinTTY: false });
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors,tracing,replay"],
      });
      expect(capturedArgs?.features).toEqual([
        "errorMonitoring",
        "performanceMonitoring",
        "sessionReplay",
      ]);
      expect(capturedArgs?.yes).toBe(true);
      expect(runWizardSpy).toHaveBeenCalledTimes(1);
    });

    test("--dry-run bypasses non-TTY validation without --yes or --features", async () => {
      const ctx = makeContext("/projects/app", { stdinTTY: false });
      await func.call(ctx, { yes: false, "dry-run": true });
      expect(capturedArgs?.dryRun).toBe(true);
      expect(runWizardSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("authentication preflight", () => {
    test("refreshes auth before background work and wizard startup", async () => {
      const ctx = makeContext();

      await func.call(ctx, DEFAULT_FLAGS);

      expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
      const refreshOrder = refreshTokenSpy.mock.invocationCallOrder[0];
      const warmOrder = warmSpy.mock.invocationCallOrder[0];
      const wizardOrder = runWizardSpy.mock.invocationCallOrder[0];
      expect(refreshOrder).toBeLessThan(warmOrder ?? 0);
      expect(refreshOrder).toBeLessThan(wizardOrder ?? 0);
    });

    test("propagates AuthError before background work or wizard startup", async () => {
      const authError = new AuthError("expired");
      refreshTokenSpy.mockRejectedValueOnce(authError);
      const ctx = makeContext();

      await expect(func.call(ctx, DEFAULT_FLAGS)).rejects.toBe(authError);

      expect(warmSpy).not.toHaveBeenCalled();
      expect(runWizardSpy).not.toHaveBeenCalled();
    });
  });

  // ── No arguments ──────────────────────────────────────────────────────

  describe("no arguments", () => {
    test("defaults to cwd with auto-detect", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS);
      expect(capturedArgs?.directory).toBe("/projects/app");
      expect(capturedArgs?.org).toBeUndefined();
      expect(capturedArgs?.project).toBeUndefined();
    });
  });

  // ── Single path argument ──────────────────────────────────────────────

  describe("single path argument", () => {
    test(". resolves to cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, ".");
      expect(capturedArgs?.directory).toBe(path.resolve("/projects/app", "."));
      expect(capturedArgs?.org).toBeUndefined();
      expect(capturedArgs?.project).toBeUndefined();
    });

    test("./subdir resolves relative to cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "./subdir");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
      expect(capturedArgs?.org).toBeUndefined();
    });

    test("../other resolves relative to cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "../other");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "../other")
      );
      expect(capturedArgs?.org).toBeUndefined();
    });

    test("/absolute/path used as-is", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "/absolute/path");
      expect(capturedArgs?.directory).toBe("/absolute/path");
      expect(capturedArgs?.org).toBeUndefined();
    });

    test("~/path treated as literal path (no shell expansion)", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "~/projects/other");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "~/projects/other")
      );
      expect(capturedArgs?.org).toBeUndefined();
    });
  });

  // ── Single target argument ────────────────────────────────────────────

  describe("single target argument", () => {
    test("org/ sets explicit org, dir = cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "acme/");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBeUndefined();
      expect(capturedArgs?.directory).toBe("/projects/app");
    });

    test("org/project sets both, dir = cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "acme/my-app");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe("/projects/app");
    });

    test("bare slug found → uses existing project", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "my-app");
      expect(findProjectsSpy).toHaveBeenCalledWith("my-app");
      expect(capturedArgs?.org).toBe("resolved-org");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe("/projects/app");
    });

    test("bare slug not found → passes as new project name", async () => {
      findProjectsSpy.mockImplementation(async () => ({
        projects: [],
        orgs: [MOCK_ORG],
      }));
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "new-app");
      expect(capturedArgs?.org).toBeUndefined();
      expect(capturedArgs?.project).toBe("new-app");
      expect(capturedArgs?.directory).toBe("/projects/app");
    });

    test("bare slug miss stays a new project even when a fuzzy candidate exists", async () => {
      findProjectsSpy.mockResolvedValue({
        projects: [],
        orgs: [MOCK_ORG],
      });
      listProjectsSpy.mockResolvedValue([
        mockProject("new-application", MOCK_ORG.slug),
      ]);
      const ctx = makeContext("/projects/app");

      await func.call(ctx, DEFAULT_FLAGS, "new-app");

      expect(capturedArgs?.org).toBeUndefined();
      expect(capturedArgs?.project).toBe("new-app");
      expect(listProjectsSpy).not.toHaveBeenCalled();
    });

    test("bare slug matches org name → treated as org-only", async () => {
      const orgSlug = "acme-corp";
      findProjectsSpy.mockImplementation(async () => ({
        projects: [],
        orgs: [{ id: "2", slug: orgSlug, name: "Acme Corp" }],
      }));
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, orgSlug);
      expect(capturedArgs?.org).toBe(orgSlug);
      expect(capturedArgs?.project).toBeUndefined();
    });

    test("bare slug in multiple orgs → throws ValidationError", async () => {
      findProjectsSpy.mockImplementation(async (slug: string) => ({
        projects: [mockProject(slug, "org-a"), mockProject(slug, "org-b")],
        orgs: [
          { id: "1", slug: "org-a", name: "Org A" },
          { id: "2", slug: "org-b", name: "Org B" },
        ],
      }));
      const ctx = makeContext();
      await expect(func.call(ctx, DEFAULT_FLAGS, "my-app")).rejects.toThrow(
        ValidationError
      );
    });
  });

  // ── Two arguments: target + directory ─────────────────────────────────

  describe("two arguments (target + directory)", () => {
    test("org/ + path", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "acme/", "./subdir");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBeUndefined();
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
    });

    test("org/project + path", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "acme/my-app", "./subdir");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
    });

    test("bare slug + path", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "my-app", "./subdir");
      expect(findProjectsSpy).toHaveBeenCalled();
      expect(capturedArgs?.org).toBe("resolved-org");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
    });
  });

  // ── Swapped arguments ─────────────────────────────────────────────────

  describe("swapped arguments (path first, target second)", () => {
    test(". org/ swaps with warning", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, ".", "acme/");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBeUndefined();
      expect(capturedArgs?.directory).toBe(path.resolve("/projects/app", "."));
    });

    test("./subdir org/project swaps with warning", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "./subdir", "acme/my-app");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
    });
  });

  // ── Error cases ───────────────────────────────────────────────────────

  describe("error cases", () => {
    test("two paths throws ValidationError with specific message", async () => {
      const ctx = makeContext();
      const promise = func.call(ctx, DEFAULT_FLAGS, "./dir1", "./dir2");
      await expect(promise).rejects.toThrow(ValidationError);
      await expect(promise).rejects.toThrow(
        '"./dir1" and "./dir2" are both directory paths'
      );
    });

    test("two targets throws ValidationError with specific message", async () => {
      const ctx = makeContext();
      const promise = func.call(ctx, DEFAULT_FLAGS, "acme/", "other/");
      await expect(promise).rejects.toThrow(ValidationError);
      await expect(promise).rejects.toThrow(
        '"acme/" and "other/" are both treated as targets'
      );
    });

    test("org slug with whitespace is rejected by validateResourceId", async () => {
      // Spaces in org slugs now hit validateResourceId and throw
      // ValidationError — normalizeSlug no longer converts them.
      const ctx = makeContext();
      await expect(func.call(ctx, DEFAULT_FLAGS, "acme corp/")).rejects.toThrow(
        ValidationError
      );
    });
  });

  // ── Flag forwarding ───────────────────────────────────────────────────

  describe("flag forwarding", () => {
    test("forwards yes and dry-run flags", async () => {
      const ctx = makeContext();
      await func.call(ctx, { yes: true, "dry-run": true });
      expect(capturedArgs?.yes).toBe(true);
      expect(capturedArgs?.dryRun).toBe(true);
    });

    test("forwards team flag alongside org/project", async () => {
      const ctx = makeContext();
      await func.call(
        ctx,
        { ...DEFAULT_FLAGS, team: "backend" },
        "acme/my-app"
      );
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.team).toBe("backend");
    });
  });

  // ── Background org detection ──────────────────────────────────────────

  describe("background org detection", () => {
    test("warms prefetch when org is not explicit", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS);
      expect(warmSpy).toHaveBeenCalledTimes(1);
      expect(warmSpy).toHaveBeenCalledWith("/projects/app");
    });

    test("skips prefetch when org is explicit", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "acme/my-app");
      expect(warmSpy).not.toHaveBeenCalled();
    });

    test("skips prefetch when org-only is explicit", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "acme/");
      expect(warmSpy).not.toHaveBeenCalled();
    });

    test("skips prefetch for bare slug when project found", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "my-app");
      // findProjectsBySlug returns a match → org is known, no prefetch needed
      expect(warmSpy).not.toHaveBeenCalled();
    });

    test("warms prefetch for bare slug when project not found", async () => {
      findProjectsSpy.mockImplementation(async () => ({
        projects: [],
        orgs: [MOCK_ORG],
      }));
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "new-app");
      // No project found → org is undefined → prefetch warms
      expect(warmSpy).toHaveBeenCalledTimes(1);
      expect(warmSpy).toHaveBeenCalledWith("/projects/app");
    });

    test("warms prefetch for path-only arg", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "./subdir");
      expect(warmSpy).toHaveBeenCalledTimes(1);
    });

    test("warms prefetch with resolved directory path", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "./subdir");
      expect(warmSpy).toHaveBeenCalledWith(
        path.resolve("/projects/app", "./subdir")
      );
    });
  });
});
