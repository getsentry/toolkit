/**
 * Token command shared helper tests
 */

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/lib/scope-recovery.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/scope-recovery.js")>();
  return { ...actual, ensureScopesForAction: vi.fn() };
});

import {
  CREATE_SCOPES,
  ensureTokenScopes,
  explainTokenForbidden,
  parseOrgScopedArg,
} from "../../../src/commands/token/shared.js";
import { ApiError, AuthError, ContextError } from "../../../src/lib/errors.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for vi.mocked access
import * as scopeRecovery from "../../../src/lib/scope-recovery.js";

const USAGE = "sentry token create [<org>/]<name>";

describe("parseOrgScopedArg", () => {
  test("splits an org prefix", () => {
    expect(parseOrgScopedArg("my-org/ci", "Token name", USAGE)).toEqual({
      orgSlug: "my-org",
      value: "ci",
    });
  });

  test("keeps a bare value", () => {
    expect(parseOrgScopedArg("ci", "Token name", USAGE)).toEqual({
      value: "ci",
    });
  });

  test("only splits on the first slash, so names can contain slashes", () => {
    expect(
      parseOrgScopedArg("my-org/deploy/prod", "Token name", USAGE),
    ).toEqual({ orgSlug: "my-org", value: "deploy/prod" });
  });

  test("keeps a prefix that isn't an org slug in the value", () => {
    expect(parseOrgScopedArg("My Token/prod", "Token name", USAGE)).toEqual({
      value: "My Token/prod",
    });
  });

  test("rejects an empty value", () => {
    expect(() => parseOrgScopedArg("", "Token name", USAGE)).toThrow(
      ContextError,
    );
    expect(() => parseOrgScopedArg("my-org/", "Token name", USAGE)).toThrow(
      ContextError,
    );
  });
});

describe("ensureTokenScopes", () => {
  const ensureScopesSpy = vi.mocked(scopeRecovery.ensureScopesForAction);

  afterEach(() => ensureScopesSpy.mockReset());

  test("reports whether the scopes are still missing", async () => {
    ensureScopesSpy.mockResolvedValue("ready");
    await expect(ensureTokenScopes(CREATE_SCOPES, "x")).resolves.toBe(false);

    ensureScopesSpy.mockResolvedValue("elevated");
    await expect(ensureTokenScopes(CREATE_SCOPES, "x")).resolves.toBe(false);

    ensureScopesSpy.mockResolvedValue("unavailable");
    await expect(ensureTokenScopes(CREATE_SCOPES, "x")).resolves.toBe(true);
  });

  test("throws when the authorization is not completed", async () => {
    ensureScopesSpy.mockResolvedValue("declined");
    await expect(ensureTokenScopes(CREATE_SCOPES, "x")).rejects.toThrow(
      AuthError,
    );
  });
});

describe("explainTokenForbidden", () => {
  test("passes through errors other than 403", () => {
    const error = new ApiError("Not found", 404);
    expect(explainTokenForbidden(error, CREATE_SCOPES, false)).toBe(error);
  });

  test("names the auth method, scopes, and role on a 403", () => {
    const error = explainTokenForbidden(
      new ApiError("Forbidden", 403),
      CREATE_SCOPES,
      false,
    );
    expect(error).toBeInstanceOf(ApiError);
    const detail = (error as ApiError).detail;
    expect(detail).toContain("sentry auth login");
    expect(detail).toContain("org:tokens, org:read, org:ci");
    expect(detail).toContain("org role");
  });

  test("says how to re-authorize when elevation was skipped", () => {
    const error = explainTokenForbidden(
      new ApiError("Forbidden", 403),
      CREATE_SCOPES,
      true,
    );
    expect((error as ApiError).detail).toContain(
      "skipped with --yes, --json, or --dry-run",
    );
  });
});
