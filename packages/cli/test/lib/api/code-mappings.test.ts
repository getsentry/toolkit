import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { uploadCodeMappings } from "../../../src/lib/api/code-mappings.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("api-code-mappings-");

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetAuthenticatedFetch();
  setAuthToken("test-token");
  setOrgRegion("test-org", DEFAULT_SENTRY_URL);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
});

describe("uploadCodeMappings", () => {
  test("POSTs a snake_case body to the bulk endpoint", async () => {
    let body: unknown;
    globalThis.fetch = mockFetch(async (input, init) => {
      const req = new Request(input!, init);
      expect(req.method).toBe("POST");
      expect(req.url).toBe(
        `${DEFAULT_SENTRY_URL}/api/0/organizations/test-org/code-mappings/bulk/`,
      );
      body = await req.json();
      return Response.json({
        created: 1,
        updated: 0,
        errors: 0,
        mappings: [
          { stackRoot: "com/example", sourceRoot: "src", status: "created" },
        ],
      });
    });

    const result = await uploadCodeMappings({
      org: "test-org",
      project: "test-project",
      repository: "owner/repo",
      defaultBranch: "main",
      mappings: [{ stackRoot: "com/example", sourceRoot: "src" }],
    });

    expect(body).toEqual({
      project: "test-project",
      repository: "owner/repo",
      default_branch: "main",
      mappings: [{ stack_root: "com/example", source_root: "src" }],
    });
    expect(result).toEqual({
      created: 1,
      updated: 0,
      errors: 0,
      mappings: [
        { stackRoot: "com/example", sourceRoot: "src", status: "created" },
      ],
    });
  });

  test("returns per-mapping errors from a 207 response", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json(
        {
          created: 0,
          updated: 0,
          errors: 1,
          mappings: [
            {
              stackRoot: "com/example",
              sourceRoot: "src",
              status: "error",
              detail: "Repository not found",
            },
          ],
        },
        { status: 207 },
      ),
    );

    const result = await uploadCodeMappings({
      org: "test-org",
      project: "test-project",
      repository: "owner/repo",
      defaultBranch: "main",
      mappings: [{ stackRoot: "com/example", sourceRoot: "src" }],
    });

    expect(result.errors).toBe(1);
    expect(result.mappings[0]?.detail).toBe("Repository not found");
  });
});
