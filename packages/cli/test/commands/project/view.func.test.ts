/**
 * Project View Command Func Tests
 *
 * Tests for the viewCommand func() body in src/commands/project/view.ts.
 * Uses spyOn to mock api-client, resolve-target, and browser to test
 * the func() body without real HTTP calls or database access.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { viewCommand } from "../../../src/commands/project/view.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/browser.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/browser.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../../src/lib/browser.js";
import { AuthError, ContextError } from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import type { ProjectKey, SentryProject } from "../../../src/types/sentry.js";

const sampleProject: SentryProject = {
  id: "42",
  slug: "test-project",
  name: "Test Project",
  platform: "javascript",
  dateCreated: "2025-01-01T00:00:00.000Z",
  status: "active",
};

const _sampleKeys: ProjectKey[] = [
  {
    id: "key-1",
    name: "Default",
    dsn: { public: "https://abc123@o1.ingest.sentry.io/42" },
    isActive: true,
  },
];

function createMockContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    stdoutWrite,
  };
}

describe("viewCommand.func", () => {
  const getProjectSpy = vi.mocked(apiClient.getProject);
  // The command calls tryGetPrimaryDsn (not getProjectKeys directly).
  // tryGetPrimaryDsn wraps getProjectKeys internally (same-file call),
  // so we mock tryGetPrimaryDsn to control DSN resolution.
  const tryGetPrimaryDsnSpy = vi.mocked(apiClient.tryGetPrimaryDsn);
  const resolveAllTargetsSpy = vi.mocked(resolveTarget.resolveAllTargets);
  const resolveProjectBoundSlugSpy = vi.mocked(
    resolveTarget.resolveProjectBoundSlug
  );
  const openInBrowserSpy = vi.mocked(browser.openInBrowser);

  afterEach(() => {
    getProjectSpy.mockReset();
    tryGetPrimaryDsnSpy.mockReset();
    resolveAllTargetsSpy.mockReset();
    resolveProjectBoundSlugSpy.mockReset();
    openInBrowserSpy.mockReset();
  });

  test("explicit org/project outputs JSON with DSN", async () => {
    getProjectSpy.mockResolvedValue(sampleProject);
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { json: true, web: false }, "my-org/test-project");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    // JSON output is always an array for consistent shape
    expect(parsed).toBeArray();
    expect(parsed[0].slug).toBe("test-project");
    expect(parsed[0].dsn).toBe("https://abc123@o1.ingest.sentry.io/42");
  });

  test("explicit org/project outputs human-readable details", async () => {
    getProjectSpy.mockResolvedValue(sampleProject);
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(
      context,
      { json: false, web: false },
      "my-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("test-project");
    expect(output).toContain("Slug");
  });

  test("explicit org/project with --web opens browser", async () => {
    openInBrowserSpy.mockResolvedValue(undefined);

    const { context } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { json: false, web: true }, "my-org/test-project");

    expect(openInBrowserSpy).toHaveBeenCalled();
    // Should NOT fetch project details when using --web
    expect(getProjectSpy).not.toHaveBeenCalled();
  });

  test("--web with multiple auto-detected targets throws ContextError", async () => {
    resolveAllTargetsSpy.mockResolvedValue({
      targets: [
        {
          org: "org-a",
          project: "proj-1",
          orgDisplay: "org-a",
          projectDisplay: "proj-1",
        },
        {
          org: "org-b",
          project: "proj-2",
          orgDisplay: "org-b",
          projectDisplay: "proj-2",
        },
      ],
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    try {
      // No target arg triggers AutoDetect
      await func.call(context, { json: false, web: true });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      expect((error as ContextError).message).toContain("Single project");
    }
  });

  test("project search resolves and fetches project", async () => {
    resolveProjectBoundSlugSpy.mockResolvedValue({
      org: "acme",
      project: "frontend",
    });
    getProjectSpy.mockResolvedValue({ ...sampleProject, slug: "frontend" });
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { json: true, web: false }, "frontend");

    expect(resolveProjectBoundSlugSpy).toHaveBeenCalledWith(
      "frontend",
      "sentry project view <org>/<project>",
      "sentry project view <org>/frontend",
      undefined
    );
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toBeArray();
    expect(parsed[0].slug).toBe("frontend");
  });

  test("org-only target (org/) throws ContextError", async () => {
    const { context } = createMockContext();
    const func = await viewCommand.loader();

    try {
      await func.call(context, { json: false, web: false }, "my-org/");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      expect((error as ContextError).message).toContain("Specific project");
      expect((error as ContextError).message).toContain(
        "not just the organization"
      );
    }
  });

  test("auto-detect uses resolveAllTargets and writes footer", async () => {
    resolveAllTargetsSpy.mockResolvedValue({
      targets: [
        {
          org: "my-org",
          project: "backend",
          orgDisplay: "my-org",
          projectDisplay: "backend",
          detectedFrom: ".env",
        },
      ],
      footer: "Detected 1 project from .env",
    });
    getProjectSpy.mockResolvedValue({ ...sampleProject, slug: "backend" });
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    // No target arg triggers AutoDetect
    await func.call(context, { json: false, web: false });

    expect(resolveAllTargetsSpy).toHaveBeenCalled();
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("backend");
    expect(output).toContain("Detected 1 project from .env");
  });

  test("auto-detect with 0 targets throws ContextError", async () => {
    resolveAllTargetsSpy.mockResolvedValue({ targets: [] });

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false })
    ).rejects.toThrow(ContextError);
  });

  test("auto-detect with skippedSelfHosted includes DSN hint in error", async () => {
    resolveAllTargetsSpy.mockResolvedValue({
      targets: [],
      skippedSelfHosted: 3,
    });

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    try {
      await func.call(context, { json: false, web: false });
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      const msg = (error as ContextError).message;
      expect(msg).toContain("3 DSN(s)");
      expect(msg).toContain("could not be resolved");
    }
  });

  test("non-auth API error on explicit target is rethrown verbatim", async () => {
    // Previously the error was swallowed and a generic
    // "Could not auto-detect organization and project" ContextError
    // was raised — confusing because the user provided the target
    // explicitly (getsentry/cli#785 item #8). The actual API error
    // must bubble up so the user sees the real cause (404/403/etc.).
    const apiErr = new Error("404 Not Found");
    getProjectSpy.mockRejectedValue(apiErr);
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false }, "my-org/bad-project")
    ).rejects.toThrow("404 Not Found");

    expect(getProjectSpy).toHaveBeenCalledWith("my-org", "bad-project");
  });

  test("non-auth API error on project-search target is rethrown verbatim", async () => {
    resolveProjectBoundSlugSpy.mockResolvedValue({
      org: "acme",
      project: "frontend",
    });
    const apiErr = new Error("403 Forbidden");
    getProjectSpy.mockRejectedValue(apiErr);
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false }, "frontend")
    ).rejects.toThrow("403 Forbidden");
  });

  test("non-auth API error on auto-detect target is swallowed (multi-target recovery)", async () => {
    // For auto-detect — which may surface multiple DSN-discovered
    // targets — per-target failures are still tolerated: one
    // inaccessible DSN must not block the rest of the results. When
    // all targets fail and the set ends up empty, the original
    // ContextError is still the right surface.
    resolveAllTargetsSpy.mockResolvedValue({
      targets: [
        {
          org: "my-org",
          project: "inaccessible",
          orgDisplay: "my-org",
          projectDisplay: "inaccessible",
        },
      ],
    });
    getProjectSpy.mockRejectedValue(new Error("403 Forbidden"));
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false })
    ).rejects.toThrow(ContextError);
  });

  test("auth error from API is rethrown", async () => {
    getProjectSpy.mockRejectedValue(new AuthError("not_authenticated"));
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context } = createMockContext();
    const func = await viewCommand.loader();

    await expect(
      func.call(context, { json: false, web: false }, "my-org/test-project")
    ).rejects.toThrow(AuthError);
  });

  test("JSON output re-hydrates organization.name when API response omits it", async () => {
    // Collapsed API response: `organization.name` is absent. The command's
    // jsonTransform must refill it via `resolveOrgDisplayName()` so scripts
    // / agents that scrape `.organization.name` continue to see a value.
    getProjectSpy.mockResolvedValue({
      ...sampleProject,
      organization: { id: "1", slug: "my-org" },
    });
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { json: true, web: false }, "my-org/test-project");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed[0].organization.slug).toBe("my-org");
    // Fallback to slug when no cached display name is available
    expect(parsed[0].organization.name).toBe("my-org");
  });

  test("JSON output preserves organization.name when API response includes it", async () => {
    // Self-hosted / older Sentry ignore `?collapse=organization` and return
    // the full payload — don't clobber `name` when it's already set.
    getProjectSpy.mockResolvedValue({
      ...sampleProject,
      organization: { id: "1", slug: "my-org", name: "My Organization" },
    });
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { json: true, web: false }, "my-org/test-project");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed[0].organization.name).toBe("My Organization");
  });

  test("JSON output still strips detectedFrom (human-only field)", async () => {
    getProjectSpy.mockResolvedValue(sampleProject);
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    await func.call(context, { json: true, web: false }, "my-org/test-project");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed[0]).not.toHaveProperty("detectedFrom");
  });

  test("JSON output honours --fields filter", async () => {
    getProjectSpy.mockResolvedValue({
      ...sampleProject,
      organization: { id: "1", slug: "my-org" },
    });
    tryGetPrimaryDsnSpy.mockResolvedValue(
      "https://abc123@o1.ingest.sentry.io/42"
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await viewCommand.loader();
    // `fields` is auto-injected by the buildCommand wrapper; pass through
    // the flag shape the wrapper would forward.
    await func.call(
      context,
      {
        json: true,
        web: false,
        fields: ["slug", "organization.slug"],
      },
      "my-org/test-project"
    );

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed[0]).toEqual({
      slug: "test-project",
      organization: { slug: "my-org" },
    });
  });
});
