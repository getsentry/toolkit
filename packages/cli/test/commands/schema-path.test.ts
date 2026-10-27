/**
 * Tests for `sentry schema` path lookup (`METHOD /api/0/...`).
 */

import { describe, expect, test, vi } from "vitest";
import { schemaCommand } from "../../src/commands/schema.js";
import type { SentryContext } from "../../src/context.js";
import { getAllEndpoints } from "../../src/lib/api-schema.js";
import { OutputError, ResolutionError } from "../../src/lib/errors.js";

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
  test.each([
    ["listOrganizationIssues"],
    ["issues", "listOrganizationIssues"],
    ["GET", "listOrganizationIssues"],
    ["GET", "issues", "listOrganizationIssues"],
    ["GET listOrganizationIssues"],
    [SKILL_QUERY],
    ["GET", ORG_ISSUES],
  ])("exact lookup preserves the endpoint object for %j", async (...args) => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: true, all: false }, ...args);
    expect(JSON.parse(stdoutOf(stdoutWrite))).toEqual(
      getAllEndpoints().find(
        (endpoint) => endpoint.fn === "listOrganizationIssues",
      ),
    );
  });

  test("--search keeps exact HTTP-qualified identifiers in an array and rejects a different method", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(
      context,
      { json: true, all: false, search: "GET" },
      "listOrganizationEvents",
    );
    expect(JSON.parse(stdoutOf(stdoutWrite))).toEqual([
      getAllEndpoints().find(
        (endpoint) => endpoint.fn === "listOrganizationEvents",
      ),
    ]);

    const incompatible = createMockContext();
    await expect(
      func.call(
        incompatible.context,
        { json: true, all: false },
        "POST",
        "listOrganizationEvents",
      ),
    ).rejects.toBeInstanceOf(ResolutionError);
    expect(stdoutOf(incompatible.stdoutWrite)).toBe("");
  });

  test("--all remains an unannotated flat array", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: true, all: true });
    expect(JSON.parse(stdoutOf(stdoutWrite))).toEqual(getAllEndpoints());
  });

  test.each([
    {
      args: ["log", "list"],
      fn: "listOrganizationEvents",
      command: "sentry log list",
      note: "dataset=logs",
    },
    {
      args: ["logs"],
      fn: "listOrganizationEvents",
      command: "sentry log list",
      note: "dataset=logs",
    },
    {
      args: ["trace", "ls"],
      fn: "listOrganizationEvents",
      command: "sentry trace list",
      note: "is_transaction:true",
    },
    {
      args: ["trace", "view"],
      fn: "getOrganizationTrace",
      command: "sentry trace view",
    },
    {
      args: ["alert", "metrics", "view"],
      fn: "getOrganizationDetector",
      command: "sentry alert metrics view",
    },
  ])("discovers the API used by $args", async ({ args, fn, command, note }) => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: true, all: false }, ...args);
    const result = JSON.parse(stdoutOf(stdoutWrite));
    expect(Array.isArray(result)).toBe(true);
    const endpoint = result.find(
      (candidate: { fn: string }) => candidate.fn === fn,
    );
    expect(endpoint?.match.relatedCommands).toContainEqual(
      expect.objectContaining({ command }),
    );
    if (note) {
      expect(
        endpoint.match.relatedCommands.find(
          (candidate: { command: string }) => candidate.command === command,
        ).note,
      ).toContain(note);
    }
  });

  test("--search and positionals share discovery, including a complete nested path", async () => {
    const positional = createMockContext();
    const search = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(
      positional.context,
      { json: true, all: false },
      "alert",
      "metrics",
      "view",
    );
    await func.call(
      search.context,
      { json: true, all: false, search: "alert" },
      "metrics",
      "view",
    );
    expect(JSON.parse(stdoutOf(search.stdoutWrite))).toEqual(
      JSON.parse(stdoutOf(positional.stdoutWrite)),
    );
  });

  test.each([
    {
      args: ["trace", "ls"],
      search: false,
      fn: "listOrganizationEvents",
      command: "sentry trace list",
    },
    {
      args: ["alert", "metrics", "view"],
      search: true,
      fn: "getOrganizationDetector",
      command: "sentry alert metrics view",
    },
  ])(
    "HTTP filters preserve CLI discovery for $args",
    async ({ args, search, fn, command }) => {
      const { context, stdoutWrite } = createMockContext();
      const func = await schemaCommand.loader();
      await func.call(
        context,
        { json: true, all: false, search: search ? "GET" : undefined },
        ...(search ? args : ["GET", ...args]),
      );
      expect(JSON.parse(stdoutOf(stdoutWrite))).toContainEqual(
        expect.objectContaining({
          fn,
          method: "GET",
          match: expect.objectContaining({
            relatedCommands: expect.arrayContaining([
              expect.objectContaining({ command }),
            ]),
          }),
        }),
      );

      const incompatible = createMockContext();
      await expect(
        func.call(
          incompatible.context,
          { json: true, all: false, search: search ? "POST" : undefined },
          ...(search ? args : ["POST", ...args]),
        ),
      ).rejects.toBeInstanceOf(search ? OutputError : ResolutionError);
      expect(stdoutOf(incompatible.stdoutWrite).trim()).toBe(
        search ? "[]" : "",
      );
    },
  );

  test("renders the selector and related CLI command in human output", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: false, all: false }, "logs");
    const output = stdoutOf(stdoutWrite);
    expect(output).toContain("dataset=logs");
    expect(output).toContain("sentry log list");
  });

  test("discovery supports existing --fields filtering", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(
      context,
      { json: true, all: false, fields: ["fn"] },
      "log",
      "list",
    );
    const result = JSON.parse(stdoutOf(stdoutWrite));
    expect(result).toContainEqual({ fn: "listOrganizationEvents" });
    expect(
      result.every((endpoint: object) => Object.keys(endpoint).join() === "fn"),
    ).toBe(true);
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
      ORG_ISSUES,
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
      "Available methods at this path: DELETE, GET, PUT",
    );
    expect(message).toContain(`sentry schema "GET ${ORG_ISSUES}"`);
  });

  test("resource discovery preserves the endpoint array JSON shape", async () => {
    const { context, stdoutWrite } = createMockContext();
    const func = await schemaCommand.loader();
    await func.call(context, { json: true, all: false }, "issues");

    const parsed = JSON.parse(stdoutOf(stdoutWrite));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(3);
    expect(
      parsed.some((e: { fn: string }) => e.fn === "listOrganizationIssues"),
    ).toBe(true);
  });
});
