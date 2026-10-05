/**
 * Tests for `sentry schema` path lookup (`METHOD /api/0/...`).
 */

import { describe, expect, test, vi } from "vitest";
import { schemaCommand } from "../../src/commands/schema.js";
import type { SentryContext } from "../../src/context.js";
import { ResolutionError } from "../../src/lib/errors.js";

const ORG_ISSUES = "/api/0/organizations/{organization_id_or_slug}/issues/";
const SKILL_QUERY = `GET ${ORG_ISSUES}`;

function createMockContext(): {
  context: SentryContext;
  stdoutWrite: ReturnType<typeof vi.fn>;
} {
  const stdoutWrite = vi.fn(() => true);
  return {
    context: {
      process,
      env: process.env,
      stdout: { write: stdoutWrite },
      stderr: { write: vi.fn(() => true) },
      stdin: process.stdin,
      cwd: "/tmp",
      homeDir: "/tmp",
      configDir: "/tmp",
    },
    stdoutWrite,
  };
}

function stdoutOf(stdoutWrite: ReturnType<typeof vi.fn>): string {
  return stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
}

describe("sentry schema path lookup", () => {
  test("METHOD + path returns that endpoint", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: true, all: false }, SKILL_QUERY);

    const parsed = JSON.parse(stdoutOf(stdoutWrite));
    expect(parsed.fn).toBe("listOrganizationIssues");
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe(ORG_ISSUES);
  });

  test("unquoted METHOD and path as two positionals also match", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: true, all: false }, "GET", ORG_ISSUES);

    const parsed = JSON.parse(stdoutOf(stdoutWrite));
    expect(parsed.fn).toBe("listOrganizationIssues");
  });

  test("path without METHOD lists methods on that URL", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: true, all: false }, ORG_ISSUES);

    const parsed = JSON.parse(stdoutOf(stdoutWrite));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((e: { method: string }) => e.method).sort()).toEqual([
      "DELETE",
      "GET",
      "PUT",
    ]);
  });

  test("--search with GET + path finds the endpoint", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: true, all: false, search: SKILL_QUERY });

    const parsed = JSON.parse(stdoutOf(stdoutWrite));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].fn).toBe("listOrganizationIssues");
  });

  test("--search GET plus path positional (unquoted) finds the endpoint", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(
      context,
      { json: true, all: false, search: "GET" },
      ORG_ISSUES
    );

    const parsed = JSON.parse(stdoutOf(stdoutWrite));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].fn).toBe("listOrganizationIssues");
  });

  test("unknown path does not suggest --search GET /path", async () => {
    const { context } = createMockContext();
    const func = await schemaCommand.loader();
    const query =
      "GET /api/0/organizations/{organization_id_or_slug}/not-a-route/";

    const err = await func
      .call(context, { json: false, all: false }, query)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResolutionError);
    const message = (err as ResolutionError).message;
    expect(message).toContain("does not exist in the schema");
    expect(message).toContain("sentry schema --search not-a-route");
    expect(message).not.toMatch(/--search GET /);
  });

  test("wrong METHOD at a real path hints the methods that exist", async () => {
    const { context } = createMockContext();
    const func = await schemaCommand.loader();

    const err = await func
      .call(context, { json: false, all: false }, `POST ${ORG_ISSUES}`)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResolutionError);
    const message = (err as ResolutionError).message;
    expect(message).toContain(
      "Available methods at this path: DELETE, GET, PUT"
    );
    expect(message).toContain(`sentry schema "GET ${ORG_ISSUES}"`);
  });

  test("resource lookup is unchanged", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: true, all: false }, "issues");

    const parsed = JSON.parse(stdoutOf(stdoutWrite));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(3);
    expect(
      parsed.every((e: { resource: string }) => e.resource === "issues")
    ).toBe(true);
  });
});
