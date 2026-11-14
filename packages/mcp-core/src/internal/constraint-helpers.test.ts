import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  getConstraintKeysToFilter,
  getConstraintParametersToInject,
} from "./constraint-helpers";

/**
 * Test suite for constraint helper functions.
 *
 * These tests verify the logic for filtering schemas and injecting parameters
 * when handling MCP constraints with parameter aliases (projectSlug → projectSlugOrId).
 */

describe("Constraint Helpers", () => {
  // Mock tool schemas for testing
  const schemaWithProjectSlugOrId = {
    organizationSlug: z.string(),
    projectSlugOrId: z.string().optional(),
    query: z.string().optional(),
  };

  const schemaWithProjectSlug = {
    organizationSlug: z.string(),
    projectSlug: z.string().optional(),
    query: z.string().optional(),
  };

  describe("getConstraintKeysToFilter", () => {
    it("filters direct constraint matches", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: null,
        regionUrl: null,
      };

      const keys = getConstraintKeysToFilter(
        constraints,
        schemaWithProjectSlug,
      );

      expect(keys).toEqual(["organizationSlug"]);
    });

    it("applies projectSlug → projectSlugOrId alias when projectSlug is constrained", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: "my-project",
        regionUrl: null,
      };

      const keys = getConstraintKeysToFilter(
        constraints,
        schemaWithProjectSlugOrId,
      );

      // Should filter both organizationSlug (direct match) and projectSlugOrId (alias)
      expect(keys).toEqual(["organizationSlug", "projectSlugOrId"]);
    });

    it("does NOT apply alias when projectSlugOrId is explicitly constrained", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: "project-a",
        projectSlugOrId: "project-b", // Explicit constraint takes precedence
        regionUrl: null,
      };

      const keys = getConstraintKeysToFilter(
        constraints,
        schemaWithProjectSlugOrId,
      );

      // Should filter organizationSlug and projectSlugOrId (explicit), but NOT the alias
      expect(keys).toEqual(["organizationSlug", "projectSlugOrId"]);
    });

    it("handles null/falsy constraint values", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: null, // Falsy - should not trigger alias
        regionUrl: null,
      };

      const keys = getConstraintKeysToFilter(
        constraints,
        schemaWithProjectSlugOrId,
      );

      expect(keys).toEqual(["organizationSlug"]);
    });

    it("handles empty string as falsy", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: "", // Empty string is falsy
        regionUrl: null,
      };

      const keys = getConstraintKeysToFilter(
        constraints,
        schemaWithProjectSlugOrId,
      );

      // Empty string is falsy, so no alias should be applied
      expect(keys).toEqual(["organizationSlug"]);
    });

    it("only filters parameters that exist in the tool schema", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: "my-project",
        regionUrl: "https://us.sentry.io",
      };

      const schemaWithoutRegion = {
        organizationSlug: z.string(),
        query: z.string(),
      };

      const keys = getConstraintKeysToFilter(constraints, schemaWithoutRegion);

      // regionUrl not in schema, so it shouldn't be filtered
      expect(keys).toEqual(["organizationSlug"]);
    });

    it("filters regionUrl when it is a resolved non-empty string on constraints", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: null,
        regionUrl: "https://us.sentry.io",
      };
      const schema = {
        organizationSlug: z.string(),
        regionUrl: z.string().nullable(),
        query: z.string().optional(),
      };
      const keys = getConstraintKeysToFilter(constraints, schema);
      expect(keys).toEqual(
        expect.arrayContaining(["organizationSlug", "regionUrl"]),
      );
      expect(keys).toHaveLength(2);
    });
  });

  describe("getConstraintParametersToInject", () => {
    it("injects direct constraint matches", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: null,
        regionUrl: null,
      };

      const params = getConstraintParametersToInject(
        constraints,
        schemaWithProjectSlug,
      );

      expect(params).toEqual({
        organizationSlug: "my-org",
      });
    });

    it("injects projectSlug as projectSlugOrId when alias applies", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: "my-project",
        regionUrl: null,
      };

      const params = getConstraintParametersToInject(
        constraints,
        schemaWithProjectSlugOrId,
      );

      expect(params).toEqual({
        organizationSlug: "my-org",
        projectSlugOrId: "my-project", // Injected via alias
      });
    });

    it("respects explicit projectSlugOrId constraint over alias", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: "project-a",
        projectSlugOrId: "project-b", // Explicit constraint
        regionUrl: null,
      };

      const params = getConstraintParametersToInject(
        constraints,
        schemaWithProjectSlugOrId,
      );

      expect(params).toEqual({
        organizationSlug: "my-org",
        projectSlugOrId: "project-b", // Explicit wins, not alias
      });
    });

    it("handles null/falsy constraint values", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: null,
        regionUrl: null,
      };

      const params = getConstraintParametersToInject(
        constraints,
        schemaWithProjectSlugOrId,
      );

      expect(params).toEqual({
        organizationSlug: "my-org",
      });
    });

    it("only injects parameters that exist in the tool schema", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: "my-project",
        regionUrl: "https://us.sentry.io",
      };

      const schemaWithoutRegion = {
        organizationSlug: z.string(),
        query: z.string(),
      };

      const params = getConstraintParametersToInject(
        constraints,
        schemaWithoutRegion,
      );

      // regionUrl not in schema, so it shouldn't be injected
      expect(params).toEqual({
        organizationSlug: "my-org",
      });
    });

    it("injects regionUrl when present on constraints and the tool declares it", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: null,
        regionUrl: "https://us.sentry.io",
      };
      const schema = {
        organizationSlug: z.string(),
        regionUrl: z.string().nullable(),
      };
      expect(getConstraintParametersToInject(constraints, schema)).toEqual({
        organizationSlug: "my-org",
        regionUrl: "https://us.sentry.io",
      });
    });
  });

  describe("Consistency between filtering and injection", () => {
    it("ensures filtered keys match injected keys", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: "my-project",
        regionUrl: null,
      };

      const keysToFilter = getConstraintKeysToFilter(
        constraints,
        schemaWithProjectSlugOrId,
      );
      const paramsToInject = getConstraintParametersToInject(
        constraints,
        schemaWithProjectSlugOrId,
      );

      // Every key that's filtered should have a corresponding injected parameter
      const injectedKeys = Object.keys(paramsToInject);
      expect(keysToFilter.sort()).toEqual(injectedKeys.sort());
    });

    it("handles explicit constraint precedence consistently", () => {
      const constraints = {
        organizationSlug: "my-org",
        projectSlug: "project-a",
        projectSlugOrId: "project-b",
        regionUrl: null,
      };

      const keysToFilter = getConstraintKeysToFilter(
        constraints,
        schemaWithProjectSlugOrId,
      );
      const paramsToInject = getConstraintParametersToInject(
        constraints,
        schemaWithProjectSlugOrId,
      );

      // Both should handle the explicit constraint the same way
      expect(keysToFilter).toContain("projectSlugOrId");
      expect(paramsToInject["projectSlugOrId"]).toBe("project-b");
      expect(paramsToInject["projectSlug"]).toBeUndefined();
    });
  });
});
