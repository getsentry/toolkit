/**
 * Where the scope rules come from. Until the installed `@sentry/api`
 * carries `x-sentry-project-scope`, they come from an interim copy of what
 * Sentry declares (`src/lib/interim-project-scope-operations.json`). Once
 * the catalog has declarations, the catalog wins, and every interim entry
 * must be in it, or deleting the copy with the bump would drop a rule.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  SCOPE_ORG_ENV_VAR,
  SCOPE_PROJECT_ENV_VAR,
  withEnv,
} from "../../src/lib/env.js";
import interim from "../../src/lib/interim-project-scope-operations.json";
import { scopeRequest } from "../../src/lib/target-scope.js";
import { projectScopeDeclarations } from "../../src/lib/target-scope-rules.js";

// A catalog that declares only the DSN lookup.
vi.mock("../../src/generated/project-scope-operations.json", () => ({
  default: {
    GET: {
      "/organizations/{organization_id_or_slug}/dsn-lookup/": "org-metadata",
    },
  },
}));

const GENERATED = new URL(
  "../../src/generated/project-scope-operations.json",
  import.meta.url,
);
const generated: Record<string, Record<string, string>> = existsSync(GENERATED)
  ? JSON.parse(readFileSync(GENERATED, "utf8"))
  : {};

/** Each declaration of a table, as `METHOD path scope`. */
function declarations(table: Record<string, Record<string, string>>) {
  return Object.entries(table).flatMap(([method, paths]) =>
    Object.entries(paths).map(([path, scope]) => `${method} ${path} ${scope}`),
  );
}

const send = async () => Response.json({ id: "1", slug: "web" });

function scoped(path: string) {
  return withEnv(
    { [SCOPE_ORG_ENV_VAR]: "acme", [SCOPE_PROJECT_ENV_VAR]: "web" },
    () => scopeRequest(`https://sentry.io/api/0/${path}`, undefined, send),
  );
}

describe("the scope rules' declarations", () => {
  test("are the interim copy while the catalog has none", () => {
    expect(projectScopeDeclarations({}, interim)).toBe(interim);
  });

  test("are the catalog's once it has any", async () => {
    const catalog = { PUT: interim.PUT };
    expect(projectScopeDeclarations(catalog, interim)).toBe(catalog);
    // The mocked catalog declares the DSN lookup but not the upload
    // options, which only the interim copy has.
    await expect(
      scoped("organizations/acme/dsn-lookup/"),
    ).resolves.toBeDefined();
    await expect(scoped("organizations/acme/chunk-upload/")).rejects.toThrow(
      /outside this session's scope/,
    );
  });

  test.skipIf(Object.keys(generated).length === 0)(
    "in the interim copy are all in the @sentry/api catalog",
    () => {
      expect(declarations(generated)).toEqual(
        expect.arrayContaining(declarations(interim)),
      );
    },
  );
});
