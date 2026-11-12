/**
 * Trace View Command Tests
 *
 * Tests for argument parsing (issue ID detection) and project resolution
 * in src/commands/trace/view.ts.
 *
 * Note: Core trace target parsing tests are in test/lib/trace-target.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseTraceViewInput } from "../../../src/commands/trace/view.js";
import type { ProjectWithOrg } from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../../src/lib/errors.js";
import { resolveProjectBoundSlug } from "../../../src/lib/resolve-target.js";

const VALID_TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";

describe("parseTraceViewInput", () => {
  test("parses trace arguments, keeping the trace ID as typed", () => {
    expect(parseTraceViewInput([VALID_TRACE_ID])).toEqual({
      trace: {
        parsed: { type: "auto-detect", traceId: VALID_TRACE_ID },
        warnings: [],
      },
    });
    expect(parseTraceViewInput(["my-org/frontend", "not-a-trace"])).toEqual({
      trace: {
        parsed: {
          type: "explicit",
          org: "my-org",
          project: "frontend",
          traceId: "not-a-trace",
        },
        targetArg: "my-org/frontend",
        warnings: [],
      },
    });
  });

  test("a missing trace ID fails to parse", () => {
    expect(() => parseTraceViewInput([])).toThrow(ContextError);
    expect(() => parseTraceViewInput(["my-org/frontend"])).toThrow(
      ContextError,
    );
  });

  test("detects issue short ID and suggests issue view (two args)", () => {
    const result = parseTraceViewInput(["CAM-82X", VALID_TRACE_ID]);
    expect(result).toMatchObject({
      suggestion: "Did you mean: sentry issue view CAM-82X",
    });
    expect(result).not.toHaveProperty("issueShortId");
  });

  test.each(["CLI-G5", "SPOTLIGHT-ELECTRON-4D"])(
    "a lone issue short ID %j is looked up as an issue",
    (shortId) => {
      expect(parseTraceViewInput([shortId])).toEqual({
        issueShortId: shortId,
      });
    },
  );
});

describe("resolveProjectBoundSlug", () => {
  const HINT = "sentry trace view [<org>/<project>/]<trace-id>";
  let findProjectsBySlugSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
  });

  describe("no projects found", () => {
    test("throws ResolutionError when project not found", async () => {
      findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

      await expect(resolveProjectBoundSlug("my-project", HINT)).rejects.toThrow(
        ResolutionError,
      );
    });

    test("includes project name in error message", async () => {
      findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });

      try {
        await resolveProjectBoundSlug("frontend", HINT);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ResolutionError);
        expect((error as ResolutionError).message).toContain(
          'Project "frontend"',
        );
        expect((error as ResolutionError).message).toContain(
          "Check that you have access",
        );
        expect((error as ResolutionError).message).toContain("not found");
      }
    });
  });

  describe("multiple projects found", () => {
    test("throws ValidationError when project exists in multiple orgs", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          { slug: "frontend", orgSlug: "org-a", id: "1", name: "Frontend" },
          { slug: "frontend", orgSlug: "org-b", id: "2", name: "Frontend" },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      await expect(resolveProjectBoundSlug("frontend", HINT)).rejects.toThrow(
        ValidationError,
      );
    });

    test("includes all orgs and trace ID in error message", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          {
            slug: "frontend",
            orgSlug: "acme-corp",
            id: "1",
            name: "Frontend",
          },
          {
            slug: "frontend",
            orgSlug: "beta-inc",
            id: "2",
            name: "Frontend",
          },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      try {
        await resolveProjectBoundSlug(
          "frontend",
          HINT,
          "sentry trace view <org>/frontend trace-456",
        );
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const message = (error as ValidationError).message;
        expect(message).toContain("exists in multiple organizations");
        expect(message).toContain("acme-corp/frontend");
        expect(message).toContain("beta-inc/frontend");
        expect(message).toContain("trace-456");
      }
    });
  });

  describe("single project found", () => {
    test("returns resolved target for single match", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          {
            slug: "backend",
            orgSlug: "my-company",
            id: "42",
            name: "Backend",
          },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      const result = await resolveProjectBoundSlug("backend", HINT);

      expect(result).toMatchObject({
        org: "my-company",
        project: "backend",
      });
      expect(result.projectData).toBeDefined();
    });

    test("uses orgSlug from project result", async () => {
      findProjectsBySlugSpy.mockResolvedValue({
        projects: [
          {
            slug: "mobile-app",
            orgSlug: "acme-industries",
            id: "100",
            name: "Mobile App",
          },
        ] as ProjectWithOrg[],
        orgs: [],
      });

      const result = await resolveProjectBoundSlug("mobile-app", HINT);

      expect(result.org).toBe("acme-industries");
      expect(result.project).toBe("mobile-app");
    });
  });
});
