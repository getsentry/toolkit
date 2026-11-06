import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ResolutionError } from "../../../src/lib/errors.js";
import { assertMcpScopeExists } from "../../../src/lib/mcp/scope-check.js";

const originalFetch = globalThis.fetch;
const requested: string[] = [];

/** Answer each request path with `respond`, recording the paths. */
function mockSentry(respond: (path: string) => Response | Promise<Response>) {
  globalThis.fetch = async (input) => {
    const url = new URL(new Request(input).url);
    requested.push(url.pathname);
    return await respond(url.pathname);
  };
}

const notFound = () => Response.json({ detail: "Not found" }, { status: 404 });

function check(
  organizationSlug?: string,
  projectSlug?: string,
  timeoutMs?: number,
) {
  return assertMcpScopeExists(
    {
      organizationSlug,
      projectSlug,
      sentryHost: "sentry.io",
      sentryProtocol: "https",
    },
    "test-token",
    timeoutMs,
  );
}

beforeEach(() => {
  requested.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("assertMcpScopeExists", () => {
  test("makes no request without a scope", async () => {
    mockSentry(() => {
      throw new Error("unexpected request");
    });
    await expect(check()).resolves.toBeUndefined();
    expect(requested).toEqual([]);
  });

  test("accepts an organization that exists with one request", async () => {
    mockSentry(() => Response.json({ id: "1", slug: "acme", name: "Acme" }));
    await expect(check("acme")).resolves.toBeUndefined();
    expect(requested).toEqual(["/api/0/organizations/acme/"]);
  });

  test("names the scope when the organization does not exist", async () => {
    mockSentry(notFound);
    const error = await check("no-such-org").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResolutionError);
    expect((error as Error).message).toContain(
      "Organization 'no-such-org' (MCP server scope 'no-such-org/') not found.",
    );
  });

  test("accepts a project that exists with one request", async () => {
    mockSentry(() =>
      Response.json({
        id: "2",
        slug: "web",
        name: "web",
        organization: { id: "1", slug: "acme" },
      }),
    );
    await expect(check("acme", "web")).resolves.toBeUndefined();
    expect(requested).toEqual(["/api/0/projects/acme/web/"]);
  });

  test("names the project when only the project does not exist", async () => {
    mockSentry((path) =>
      path.startsWith("/api/0/projects/")
        ? notFound()
        : Response.json({ id: "1", slug: "acme", name: "Acme" }),
    );
    const error = await check("acme", "no-such-project").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ResolutionError);
    expect((error as Error).message).toContain(
      "Project 'no-such-project' (MCP server scope 'acme/no-such-project') not found.",
    );
  });

  test("names the organization when the project's organization does not exist", async () => {
    mockSentry(notFound);
    const error = await check("no-such-org", "web").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResolutionError);
    expect((error as Error).message).toContain(
      "Organization 'no-such-org' (MCP server scope 'no-such-org/web') not found.",
    );
  });

  test.each([
    ["401", 401],
    ["403 (a token without org:read)", 403],
    ["500", 500],
  ])("starts anyway on a %s", async (_name, status) => {
    mockSentry(() => Response.json({ detail: "nope" }, { status }));
    await expect(check("acme", "web")).resolves.toBeUndefined();
  });

  test("starts anyway when the network is down", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND sentry.io"),
      });
    };
    await expect(check("acme")).resolves.toBeUndefined();
  });

  test("starts anyway when Sentry does not answer in time", async () => {
    mockSentry(() => new Promise<Response>(() => undefined));
    await expect(check("acme", undefined, 10)).resolves.toBeUndefined();
  });
});
