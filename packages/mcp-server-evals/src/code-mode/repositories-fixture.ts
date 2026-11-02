import assert from "node:assert/strict";
import { z } from "zod";
import { startApiFixture } from "./api-fixture";
import { parseEvalJsonAnswer } from "./json-answer";

const ORGANIZATION = "repository-evals";
const collectionPath = `/api/0/organizations/${ORGANIZATION}/repos/`;
const githubIndexes = new Set([2, 48, 100, 106]);

function repository(index: number, active = true) {
  const github = githubIndexes.has(index) || !active;
  const name = `eval/project-${String(index + 1).padStart(3, "0")}`;
  return {
    id: String(3000 + index),
    name,
    url: `https://${github ? "github.com" : "gitlab.com"}/${name}`,
    provider: {
      id: github ? "integrations:github" : "integrations:gitlab",
      name: github ? "GitHub" : "GitLab",
    },
    status: active ? "active" : "disabled",
    dateCreated: "2026-10-01T10:00:00.000Z",
    integrationId: String(github ? 7100 + index : 7200),
    externalSlug: name,
    externalId: String(9000 + index),
  };
}

const repositories = [
  ...Array.from({ length: 107 }, (_, index) => repository(index)),
  repository(999, false),
];
const activeRepositories = repositories.filter(
  (repo) => repo.status === "active",
);
const expected = activeRepositories
  .filter((repo) => repo.provider.id === "integrations:github")
  .map(({ id, name, url }) => ({ id, name, url }));
const answerSchema = z.object({
  total: z.number().int(),
  repositories: z.array(
    z.object({ id: z.string(), name: z.string(), url: z.string() }),
  ),
});

/**
 * Synthetic repositories using Sentry's public serializer fields and offset
 * pagination contract. This models listing only, not integration permissions
 * or every repository expansion. More than 100 active rows forces pagination.
 */
export async function createRepositoriesFixture({
  accessToken = "code-mode-eval-token",
  injectedFailure,
}: {
  accessToken?: string;
  injectedFailure?: "initial-503" | "permission-403";
} = {}) {
  const observedIds = new Set<string>();
  let initialReadFailed = false;
  const api = await startApiFixture(accessToken, ({ method, url }) => {
    // Standard catalog tools can resolve the organization and its projects
    // before discovering that their catalog has no repository-list operation.
    const organizationPath = "/api/0/organizations/";
    const projectsPath = `/api/0/organizations/${ORGANIZATION}/projects/`;
    if (url.pathname === organizationPath || url.pathname === projectsPath) {
      if (method !== "GET") {
        return { status: 405, body: { detail: "Method not allowed" } };
      }
      const query = url.searchParams.get("query")?.toLowerCase() ?? "";
      const metadata =
        url.pathname === organizationPath
          ? [
              {
                id: "2000",
                slug: ORGANIZATION,
                name: "Repository Evals",
                links: {
                  organizationUrl: `https://${ORGANIZATION}.sentry.io`,
                  regionUrl: "",
                },
              },
            ]
          : [
              {
                id: "2001",
                slug: "application",
                name: "Application",
                platform: "javascript",
              },
            ];
      return {
        body: metadata.filter(
          (item) =>
            item.slug.includes(query) ||
            item.name.toLowerCase().includes(query),
        ),
      };
    }
    if (url.pathname !== collectionPath) return undefined;
    if (method !== "GET") {
      return { status: 405, body: { detail: "Method not allowed" } };
    }
    // Explicit eval faults, not claims about this endpoint's backend behavior.
    if (injectedFailure === "permission-403") {
      return {
        status: 403,
        body: { detail: "You do not have permission to perform this action." },
      };
    }
    if (injectedFailure === "initial-503" && !initialReadFailed) {
      initialReadFailed = true;
      const headers: Record<string, string> = { "Retry-After": "0" };
      return {
        status: 503,
        body: { detail: "Service temporarily unavailable. Please retry." },
        headers,
      };
    }
    const perPageValue = url.searchParams.get("per_page") ?? "100";
    const perPage = Number(perPageValue);
    if (!/^\d+$/.test(perPageValue) || perPage < 1 || perPage > 100) {
      return {
        status: 400,
        body: { detail: "Invalid per_page value. Must be between 1 and 100." },
      };
    }
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor ? /^(\d+):(-?\d+):[01]$/.exec(rawCursor) : null;
    if (rawCursor && !cursor) {
      return { status: 400, body: { detail: "Invalid cursor parameter." } };
    }
    const cursorSize = cursor ? Number(cursor[1]) : 0;
    const page = cursor ? Number(cursor[2]) : 0;
    if (page < 0 || !Number.isSafeInteger(cursorSize * page)) {
      return { status: 400, body: { detail: "Invalid pagination offset." } };
    }
    const status = url.searchParams.get("status") ?? "active";
    const query = url.searchParams.get("query")?.toLowerCase() ?? "";
    const integrationId = url.searchParams.get("integration_id");
    const matching = repositories
      .filter(
        (repo) =>
          (status === "" ||
            (status === "active"
              ? repo.status === "active"
              : status === "deleted" && repo.status !== "active")) &&
          repo.name.toLowerCase().includes(query) &&
          (!integrationId || repo.integrationId === integrationId),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const offset = cursorSize * page;
    let window = matching.slice(offset, offset + (cursorSize || perPage) + 1);
    // OffsetPaginator preserves the cursor's window when page size changes.
    if (cursorSize !== perPage) window = window.slice(-(perPage + 1));
    const rows = window.slice(0, perPage);
    for (const row of rows) observedIds.add(row.id);
    const link = (relation: string, value: string, hasResults: boolean) => {
      const target = new URL(url);
      target.searchParams.set("cursor", value);
      return `<${target}>; rel="${relation}"; results="${hasResults}"; cursor="${value}"`;
    };
    return {
      body: rows,
      headers: {
        Link: [
          link("previous", `${perPage}:${page - 1}:1`, page > 0),
          link("next", `${perPage}:${page + 1}:0`, window.length > perPage),
        ].join(", "),
        "X-Hits": String(matching.length),
      },
    };
  });

  return {
    baseUrl: api.baseUrl,
    organizationSlug: ORGANIZATION,
    prompt: `List every active GitHub repository connected to organization ${ORGANIZATION}. Return JSON with total and repositories (id, name, url), sorted by name. Include the complete inventory, not just a sample. Do not change anything.`,
    cliCommands: [`sentry repo list ${ORGANIZATION}/ --limit 200 --json`],
    provenance: {
      cli: "toolkit b625111a packages/cli/src/commands/repo/list.ts and src/lib/api/repositories.ts",
      cliResultProcessing:
        "Filter the complete CLI inventory to active GitHub repositories and select id, name and url.",
      backend:
        "sentry b4b35655479 src/sentry/integrations/api/endpoints/organization_repositories.py, api/serializers/models/repository.py, api/paginator.py and utils/pagination_factory.py",
      openapi:
        "sentry-api-schema 803d6de98c9156c15e9ddc1bf9accbac6e24cebc listOrganizationRepos",
    },
    reset() {
      api.requests.length = 0;
      observedIds.clear();
      initialReadFailed = false;
    },
    snapshot() {
      return {
        repositories: structuredClone(repositories),
        requests: structuredClone(api.requests),
        observedRepositoryIds: [...observedIds],
      };
    },
    verify(text: string) {
      assert(
        api.requests.every((request) => request.method === "GET"),
        "Read-only inventory attempted a write",
      );
      assert(
        activeRepositories.every((repo) => observedIds.has(repo.id)),
        "Incomplete inventory: the agent did not retrieve every active repository",
      );
      const answer = answerSchema.parse(parseEvalJsonAnswer(text));
      assert.equal(
        answer.total,
        expected.length,
        "Incorrect GitHub repository total",
      );
      assert.deepEqual(
        answer.repositories,
        expected,
        "Repository inventory differs: missing, extra, unsorted or incorrect repositories",
      );
      return {
        success: true as const,
        repositoryIds: expected.map((repo) => repo.id),
        total: expected.length,
      };
    },
    close: api.close,
  };
}
