import { describe, expect, test } from "vitest";
import { isIdempotentOperation } from "../../src/lib/idempotent-operations.js";

const REGION_URL = "https://us.sentry.io";

describe("isIdempotentOperation", () => {
  test.each([
    "/api/0/organizations/acme/chunk-upload/",
    "/api/0/organizations/acme/artifactbundle/assemble/",
    "/api/0/projects/acme/web/files/difs/assemble/",
  ])("matches POST %s", async (path) => {
    expect(await isIdempotentOperation("POST", `${REGION_URL}${path}`)).toBe(
      true,
    );
  });

  test("ignores method case and a missing trailing slash", async () => {
    expect(
      await isIdempotentOperation(
        "post",
        `${REGION_URL}/api/0/organizations/acme/chunk-upload`,
      ),
    ).toBe(true);
  });

  test("matches under a self-hosted path prefix", async () => {
    expect(
      await isIdempotentOperation(
        "POST",
        "https://sentry.example.com/sentry/api/0/organizations/acme/chunk-upload/",
      ),
    ).toBe(true);
  });

  test("ignores the query string", async () => {
    expect(
      await isIdempotentOperation(
        "POST",
        `${REGION_URL}/api/0/organizations/acme/chunk-upload/?foo=bar`,
      ),
    ).toBe(true);
  });

  test("does not match other methods on a marked path", async () => {
    expect(
      await isIdempotentOperation(
        "PUT",
        `${REGION_URL}/api/0/organizations/acme/chunk-upload/`,
      ),
    ).toBe(false);
  });

  test("does not match writes Sentry leaves unmarked", async () => {
    expect(
      await isIdempotentOperation(
        "POST",
        `${REGION_URL}/api/0/projects/acme/web/files/preprodartifacts/assemble/`,
      ),
    ).toBe(false);
    expect(
      await isIdempotentOperation(
        "POST",
        `${REGION_URL}/api/0/organizations/acme/issues/1/autofix/`,
      ),
    ).toBe(false);
  });

  test("does not let a template segment span several path segments", async () => {
    expect(
      await isIdempotentOperation(
        "POST",
        `${REGION_URL}/api/0/organizations/acme/extra/chunk-upload/`,
      ),
    ).toBe(false);
  });

  test("returns false for safe methods, unparseable URLs, and non-API paths", async () => {
    expect(
      await isIdempotentOperation(
        "GET",
        `${REGION_URL}/api/0/organizations/acme/chunk-upload/`,
      ),
    ).toBe(false);
    expect(await isIdempotentOperation("POST", "not a url")).toBe(false);
    expect(
      await isIdempotentOperation("POST", `${REGION_URL}/organizations/acme/`),
    ).toBe(false);
  });
});
