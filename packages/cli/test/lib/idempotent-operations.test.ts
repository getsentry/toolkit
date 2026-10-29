import { describe, expect, test } from "vitest";
import { isIdempotentOperation } from "../../src/lib/idempotent-operations.js";

const REGION_URL = "https://us.sentry.io";

describe("isIdempotentOperation", () => {
  test.each([
    "/api/0/organizations/acme/chunk-upload/",
    "/api/0/organizations/acme/artifactbundle/assemble/",
    "/api/0/projects/acme/web/files/difs/assemble/",
  ])("matches POST %s", (path) => {
    expect(isIdempotentOperation("POST", `${REGION_URL}${path}`)).toBe(true);
  });

  test("ignores method case and a missing trailing slash", () => {
    expect(
      isIdempotentOperation(
        "post",
        `${REGION_URL}/api/0/organizations/acme/chunk-upload`,
      ),
    ).toBe(true);
  });

  test("matches under a self-hosted path prefix", () => {
    expect(
      isIdempotentOperation(
        "POST",
        "https://sentry.example.com/sentry/api/0/organizations/acme/chunk-upload/",
      ),
    ).toBe(true);
  });

  test("ignores the query string", () => {
    expect(
      isIdempotentOperation(
        "POST",
        `${REGION_URL}/api/0/organizations/acme/chunk-upload/?foo=bar`,
      ),
    ).toBe(true);
  });

  test("does not match other methods on a marked path", () => {
    expect(
      isIdempotentOperation(
        "PUT",
        `${REGION_URL}/api/0/organizations/acme/chunk-upload/`,
      ),
    ).toBe(false);
  });

  test("does not match writes Sentry leaves unmarked", () => {
    expect(
      isIdempotentOperation(
        "POST",
        `${REGION_URL}/api/0/projects/acme/web/files/preprodartifacts/assemble/`,
      ),
    ).toBe(false);
    expect(
      isIdempotentOperation(
        "POST",
        `${REGION_URL}/api/0/organizations/acme/issues/1/autofix/`,
      ),
    ).toBe(false);
  });

  test("does not let a template segment span several path segments", () => {
    expect(
      isIdempotentOperation(
        "POST",
        `${REGION_URL}/api/0/organizations/acme/extra/chunk-upload/`,
      ),
    ).toBe(false);
  });

  test("returns false for URLs it cannot parse or that are not API paths", () => {
    expect(isIdempotentOperation("POST", "not a url")).toBe(false);
    expect(
      isIdempotentOperation("POST", `${REGION_URL}/organizations/acme/`),
    ).toBe(false);
  });
});
