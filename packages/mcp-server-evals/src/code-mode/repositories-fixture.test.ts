import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRepositoriesDeniedFixture } from "./repositories-denied-fixture";
import { createRepositoriesFixture } from "./repositories-fixture";
import { createRepositoriesRetryFixture } from "./repositories-retry-fixture";

type Fixture = Awaited<ReturnType<typeof createRepositoriesFixture>>;
const active: Array<{ close(): Promise<void> }> = [];
const accessToken = "local-repositories-test-token";
const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  provider: z.object({ id: z.string() }),
  status: z.string(),
});

afterEach(async () => {
  await Promise.all(active.splice(0).map((fixture) => fixture.close()));
});

async function fixture() {
  const instance = await createRepositoriesFixture({ accessToken });
  active.push(instance);
  return instance;
}

function path(instance: Fixture) {
  return `${instance.baseUrl}/api/0/organizations/${instance.organizationSlug}/repos/`;
}

function request(url: string, method = "GET") {
  return fetch(url, {
    method,
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

async function readAll(instance: Fixture) {
  const rows: z.infer<typeof rowSchema>[] = [];
  let next: string | undefined = path(instance);
  while (next) {
    const response = await request(next);
    expect(response.status).toBe(200);
    rows.push(...z.array(rowSchema).parse(await response.json()));
    next = response.headers
      .get("link")
      ?.match(/<([^>]+)>; rel="next"; results="true"/)?.[1];
  }
  return rows;
}

function answer(rows: z.infer<typeof rowSchema>[]) {
  const repositories = rows
    .filter((row) => row.provider.id === "integrations:github")
    .map(({ id, name, url }) => ({ id, name, url }));
  return { total: repositories.length, repositories };
}

describe("repository inventory Code Mode eval fixture", () => {
  it("supports normal catalog organization and project discovery without exposing repository inventory", async () => {
    const instance = await fixture();
    const organizations = await request(
      `${instance.baseUrl}/api/0/organizations/?per_page=26&query=repository-evals`,
    );
    expect(organizations.status).toBe(200);
    expect(await organizations.json()).toEqual([
      {
        id: "2000",
        slug: "repository-evals",
        name: "Repository Evals",
        links: {
          organizationUrl: "https://repository-evals.sentry.io",
          regionUrl: "",
        },
      },
    ]);
    const projects = await request(
      `${instance.baseUrl}/api/0/organizations/repository-evals/projects/?per_page=26`,
    );
    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual([
      {
        id: "2001",
        slug: "application",
        name: "Application",
        platform: "javascript",
      },
    ]);
    const missing = await request(
      `${instance.baseUrl}/api/0/organizations/?query=missing-org`,
    );
    expect(await missing.json()).toEqual([]);
    expect(instance.snapshot().observedRepositoryIds).toEqual([]);
  });

  it("paginates authenticated active repositories with real cursor links and grades the complete filtered answer", async () => {
    const instance = await fixture();
    const first = await request(path(instance));
    expect(first.headers.get("link")).toContain(
      'rel="next"; results="true"; cursor="100:1:0"',
    );
    expect(z.array(rowSchema).parse(await first.json())).toHaveLength(100);
    const rows = await readAll(instance);
    expect(rows).toHaveLength(107);
    expect(rows.every((row) => row.status === "active")).toBe(true);
    const result = answer(rows);
    expect(result.repositories.map((repo) => repo.name)).toEqual([
      "eval/project-003",
      "eval/project-049",
      "eval/project-101",
      "eval/project-107",
    ]);
    expect(
      instance.verify(`\`\`\`json\n${JSON.stringify(result)}\n\`\`\``),
    ).toMatchObject({ success: true, total: 4 });
    expect(
      instance.snapshot().requests.some((r) => r.query.includes("100%3A1%3A0")),
    ).toBe(true);
    instance.reset();
    expect(instance.snapshot().requests).toEqual([]);
    expect(instance.snapshot().observedRepositoryIds).toEqual([]);
  });

  it("rejects unauthorized access, oversized pages and writes while honoring name and status filters", async () => {
    const instance = await fixture();
    expect((await fetch(path(instance))).status).toBe(401);
    expect((await request(`${path(instance)}?per_page=101`)).status).toBe(400);
    expect((await request(`${path(instance)}?cursor=broken`)).status).toBe(400);
    expect((await request(path(instance), "POST")).status).toBe(405);
    const deleted = await request(`${path(instance)}?status=deleted`);
    expect(z.array(rowSchema).parse(await deleted.json())).toMatchObject([
      { name: "eval/project-1000", status: "disabled" },
    ]);
    const filtered = await request(`${path(instance)}?query=project-107`);
    expect(z.array(rowSchema).parse(await filtered.json())).toMatchObject([
      { name: "eval/project-107" },
    ]);
    const rows = await readAll(instance);
    expect(() => instance.verify(JSON.stringify(answer(rows)))).toThrow(
      "attempted a write",
    );
  });

  it("rejects incomplete pagination, incorrect totals and extra repositories", async () => {
    const instance = await fixture();
    const first = z
      .array(rowSchema)
      .parse(await (await request(path(instance))).json());
    expect(() => instance.verify(JSON.stringify(answer(first)))).toThrow(
      "Incomplete inventory",
    );
    const rows = await readAll(instance);
    const result = answer(rows);
    expect(() =>
      instance.verify(JSON.stringify({ ...result, total: 3 })),
    ).toThrow("Incorrect GitHub repository total");
    expect(() =>
      instance.verify(
        JSON.stringify({
          ...result,
          repositories: result.repositories.slice(0, 3),
        }),
      ),
    ).toThrow("Repository inventory differs");
    const { id, name, url } = rows[0];
    expect(() =>
      instance.verify(
        JSON.stringify({
          ...result,
          repositories: [...result.repositories, { id, name, url }],
        }),
      ),
    ).toThrow("Repository inventory differs");
    instance.reset();
    expect(() => instance.verify(JSON.stringify(result))).toThrow(
      "Incomplete inventory",
    );
  });
});

describe("repository inventory injected failure evals", () => {
  it("requires recovering from one transient read failure and retrieving the complete inventory", async () => {
    const baseline = await fixture();
    const instance = await createRepositoriesRetryFixture({ accessToken });
    active.push(instance);
    expect(instance.prompt).toBe(baseline.prompt);
    const failed = await request(path(instance));
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("0");
    expect(() =>
      instance.verify(JSON.stringify({ total: 0, repositories: [] })),
    ).toThrow("Incomplete inventory");
    const rows = await readAll(instance);
    expect(instance.verify(JSON.stringify(answer(rows)))).toMatchObject({
      success: true,
      total: 4,
    });
    expect(instance.snapshot().requests.map((read) => read.status)).toEqual([
      503, 200, 200,
    ]);
    instance.reset();
    expect(instance.snapshot().requests).toEqual([]);
    expect(instance.snapshot().observedRepositoryIds).toEqual([]);
    expect((await request(path(instance))).status).toBe(503);
  });

  it("grades a permission limitation only with observed denial, bounded reads and no fabricated inventory or writes", async () => {
    const instance = await createRepositoriesDeniedFixture({ accessToken });
    active.push(instance);
    const url = `${instance.baseUrl}/api/0/organizations/${instance.organizationSlug}/repos/`;
    const blockedAnswer = {
      status: "blocked",
      reason: "No tengo acceso al inventario de repositorios.",
    };
    const blocked = JSON.stringify(blockedAnswer);
    expect(() => instance.verify(blocked)).toThrow(
      "must encounter the injected permission denial",
    );
    expect((await request(url)).status).toBe(403);
    expect(instance.verify(blocked)).toMatchObject({
      success: true,
      outcome: "blocked",
    });
    expect(
      instance.verify(JSON.stringify({ ...blockedAnswer, readOnly: true })),
    ).toMatchObject({ success: true, outcome: "blocked" });
    expect(instance.snapshot().observedRepositoryIds).toEqual([]);
    expect(() =>
      instance.verify(JSON.stringify({ total: 0, repositories: [] })),
    ).toThrow();
    expect(() =>
      instance.verify(JSON.stringify({ ...blockedAnswer, total: 0 })),
    ).toThrow();
    expect(() =>
      instance.verify(
        JSON.stringify({
          status: "blocked",
          reason: "Access denied",
          repositories: [{ id: "invented", name: "invented" }],
        }),
      ),
    ).toThrow();
    expect(() =>
      instance.verify(JSON.stringify({ status: "blocked", reason: " " })),
    ).toThrow();
    expect((await request(url)).status).toBe(403);
    expect(instance.verify(blocked).success).toBe(true);
    expect((await request(url)).status).toBe(403);
    expect(() => instance.verify(blocked)).toThrow(
      "repeatedly requested the denied inventory",
    );
    instance.reset();
    expect((await request(url)).status).toBe(403);
    expect((await request(url, "POST")).status).toBe(405);
    expect(() => instance.verify(blocked)).toThrow("attempted a write");
  });
});
