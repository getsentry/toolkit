import assert from "node:assert/strict";
import { z } from "zod";
import { startApiFixture } from "./api-fixture";
import { parseEvalJsonAnswer } from "./json-answer";

const ORGANIZATION = "release-evals";
const VERSION = "checkout@2.4.0";
const RELEASED = "2026-10-26T10:00:00.000Z";
const STARTED = "2026-10-26T10:02:00.000Z";
const FINISHED = "2026-10-26T10:04:00.000Z";
const FIXTURE_NOW = "2026-10-26T12:00:00.000Z";
const DEPLOY_NAME = "Staging rollout";
const DEPLOY_URL = "https://deploy.example.test/runs/42";
const PROJECTS = [
  { id: 101, slug: "frontend", name: "Frontend", platform: "javascript" },
  { id: 102, slug: "backend", name: "Backend", platform: "python" },
];
const date = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const answerSchema = z.object({
  version: z.string(),
  projects: z.array(z.string()),
  dateReleased: date,
  deploymentId: z
    .union([z.string(), z.number().int().positive()])
    .transform(String),
});
const releaseFields = z.object({
  ref: z.string().nullable().optional(),
  url: z
    .union([z.url(), z.literal("")])
    .nullable()
    .optional(),
  dateReleased: date.nullable().optional(),
  status: z.enum(["open", "archived"]).optional(),
});
const createReleaseSchema = releaseFields.extend({
  version: z
    .string()
    .trim()
    .min(1)
    .max(250)
    .refine((value) => !/[/\\]/.test(value)),
  projects: z.array(z.union([z.string(), z.number()])),
});
const deploySchema = z.object({
  environment: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => !/[\s/]/.test(value)),
  name: z.string().max(64).nullable().optional(),
  url: z
    .union([z.url(), z.literal("")])
    .nullable()
    .optional(),
  dateStarted: date.nullable().optional(),
  dateFinished: date.optional(),
  projects: z
    .array(z.union([z.string(), z.number()]))
    .min(1)
    .optional(),
});

export interface Deploy {
  id: string;
  environment: string;
  name: string | null;
  url: string | null;
  dateStarted: string | null;
  dateFinished: string;
}
export interface StoredDeploy {
  releaseVersion: string;
  projectSlugs: string[];
  deploy: Deploy;
}

// Shape follows the scrubbed release response in mcp-server-mocks/fixtures/release.json.
function newRelease(version: string, id: number, projects: typeof PROJECTS) {
  return {
    id,
    version,
    shortVersion: version,
    status: "open",
    ref: null as string | null,
    url: null as string | null,
    dateReleased: null as string | null,
    dateCreated: "2026-10-26T09:00:00.000Z",
    firstEvent: null,
    lastEvent: null,
    newGroups: 0,
    commitCount: 0,
    lastCommit: null,
    deployCount: 0,
    lastDeploy: null as Deploy | null,
    projects: structuredClone(projects),
    authors: [],
    owner: null,
    currentProjectMeta: {},
  };
}

/**
 * Release/deploy subset of the Sentry API, verified against backend b4b3565.
 * Preserves release-create idempotency, non-idempotent deploys and latest deploy
 * per project/environment. It does not emulate auth scopes, notifications,
 * commit association, health statistics or pagination.
 */
export async function createReleaseFixture({
  accessToken = "code-mode-eval-token",
  simulateDeployResponseLoss = false,
}: {
  accessToken?: string;
  simulateDeployResponseLoss?: boolean;
} = {}) {
  const seedDeploy: StoredDeploy = {
    releaseVersion: "checkout@2.3.0",
    projectSlugs: ["frontend", "backend"],
    deploy: {
      id: "501",
      environment: "production",
      name: "Previous rollout",
      url: "https://deploy.example.test/runs/41",
      dateStarted: "2026-10-25T10:02:00.000Z",
      dateFinished: "2026-10-25T10:04:00.000Z",
    },
  };
  const seedRelease = {
    ...newRelease(seedDeploy.releaseVersion, 100, PROJECTS),
    dateReleased: "2026-10-25T10:00:00.000Z",
    deployCount: 1,
    lastDeploy: seedDeploy.deploy,
  };
  let releases = new Map<string, ReturnType<typeof newRelease>>([
    [seedRelease.version, structuredClone(seedRelease)],
  ]);
  let deploys = [structuredClone(seedDeploy)];
  let nextReleaseId = 201;
  let nextDeployId = 601;
  let deployResponseLost = false;
  const collectionPath = `/api/0/organizations/${ORGANIZATION}/releases/`;
  const resolveProjects = (values: Array<string | number>) =>
    values.map((value) =>
      PROJECTS.find(
        (project) =>
          project.slug === value || String(project.id) === String(value),
      ),
    );

  const api = await startApiFixture(accessToken, ({ method, url, body }) => {
    let path = decodeURIComponent(url.pathname);
    const projectPath = path.match(
      new RegExp(`^/api/0/projects/${ORGANIZATION}/([^/]+)/releases/(.*)$`),
    );
    const scopedProject = projectPath
      ? resolveProjects([projectPath[1]])[0]
      : undefined;
    if (projectPath) {
      if (!scopedProject)
        return {
          status: 404,
          body: { detail: "The requested project does not exist" },
        };
      if (method !== "GET") return undefined;
      path = `${collectionPath}${projectPath[2]}`;
    }
    if (
      path === `/api/0/organizations/${ORGANIZATION}/projects/` &&
      method === "GET"
    ) {
      return { body: PROJECTS };
    }
    if (path === collectionPath && method === "GET") {
      const query = url.searchParams.get("query")?.toLowerCase() ?? "";
      return {
        body: [...releases.values()].filter(
          (release) =>
            release.version.toLowerCase().includes(query) &&
            (!scopedProject ||
              release.projects.some(
                (project) => project.id === scopedProject.id,
              )),
        ),
      };
    }
    if (path === collectionPath && method === "POST") {
      const input = createReleaseSchema.parse(body);
      const projects = resolveProjects(input.projects);
      if (projects.some((project) => !project))
        return {
          status: 400,
          body: { projects: ["Invalid project ids or slugs"] },
        };
      const existing = releases.get(input.version);
      const resolved = projects.filter(
        (project): project is (typeof PROJECTS)[number] => !!project,
      );
      if (existing) {
        if (input.status) existing.status = input.status;
        const added = resolved.filter(
          (project) =>
            !existing.projects.some((current) => current.id === project.id),
        );
        existing.projects.push(...added);
        return { status: added.length ? 201 : 208, body: existing };
      }
      const release = newRelease(input.version, nextReleaseId++, resolved);
      Object.assign(release, releaseFields.parse(input));
      releases.set(release.version, release);
      return { status: 201, body: release };
    }
    const match = path.startsWith(collectionPath)
      ? path
          .slice(collectionPath.length)
          .match(/^([^/]+)\/(deploys\/|commits\/)?$/)
      : null;
    if (!match) return undefined;
    const release = releases.get(match[1]);
    if (
      !release ||
      (scopedProject &&
        !release.projects.some((project) => project.id === scopedProject.id))
    )
      return {
        status: 404,
        body: { detail: "The requested release does not exist" },
      };
    if (!match[2]) {
      if (method === "GET") return { body: release };
      if (method === "PUT") {
        // The backend changes only truthy metadata values, without resetting projects.
        for (const [key, value] of Object.entries(releaseFields.parse(body))) {
          if (value) Object.assign(release, { [key]: value });
        }
        return { body: release };
      }
    }
    if (match[2] === "commits/" && method === "GET") return { body: [] };
    if (match[2] === "deploys/" && method === "POST") {
      const input = deploySchema.parse(body);
      const projects = input.projects
        ? resolveProjects(input.projects)
        : release.projects;
      if (
        projects.some(
          (project) =>
            !project ||
            !release.projects.some((current) => current.id === project.id),
        )
      ) {
        return {
          status: 400,
          body: { detail: "Invalid projects for release" },
        };
      }
      const deploy: Deploy = {
        id: String(nextDeployId++),
        environment: input.environment,
        name: input.name ?? null,
        url: input.url ?? null,
        dateStarted: input.dateStarted ?? null,
        dateFinished: input.dateFinished ?? FIXTURE_NOW,
      };
      deploys.push({
        releaseVersion: release.version,
        projectSlugs: projects.flatMap((project) =>
          project ? [project.slug] : [],
        ),
        deploy,
      });
      release.deployCount++;
      release.lastDeploy = deploy;
      // A synthetic gateway failure after persistence, not a Sentry endpoint contract.
      if (simulateDeployResponseLoss && !deployResponseLost) {
        deployResponseLost = true;
        return { status: 502, body: { detail: "Bad Gateway" } };
      }
      return { status: 201, body: deploy };
    }
    if (match[2] === "deploys/" && method === "GET") {
      const latest = new Map<string, Deploy>();
      for (const item of deploys.filter(
        (item) => item.releaseVersion === release.version,
      )) {
        for (const project of item.projectSlugs)
          latest.set(`${project}:${item.deploy.environment}`, item.deploy);
      }
      return {
        body: [...new Set(latest.values())].sort((a, b) =>
          b.dateFinished.localeCompare(a.dateFinished),
        ),
      };
    }
    return undefined;
  });

  return {
    baseUrl: api.baseUrl,
    prompt: [
      `In organization ${ORGANIZATION}, create release ${VERSION} for projects frontend and backend.`,
      `Finalize it with release time ${RELEASED}.`,
      `Record exactly one staging deployment named "${DEPLOY_NAME}", with URL ${DEPLOY_URL}, started at ${STARTED} and finished at ${FINISHED}.`,
      "Return JSON with version, projects (an array of project slugs), dateReleased (ISO 8601), and deploymentId, confirming the saved release and actual deployment ID.",
      "Leave existing releases and deployments unchanged.",
    ].join("\n"),
    cliCommands: [
      `sentry release create ${ORGANIZATION}/${VERSION} --project frontend,backend`,
      `sentry release finalize ${ORGANIZATION}/${VERSION} --released ${RELEASED}`,
      `sentry release deploy ${ORGANIZATION}/${VERSION} staging "${DEPLOY_NAME}" --url ${DEPLOY_URL} --started ${STARTED} --finished ${FINISHED}`,
      `sentry release deploys ${ORGANIZATION}/${VERSION} --json`,
    ],
    provenance: {
      cliCommit: "b625111aef9cc3a44abbed634a043fce8505366d",
      backendCommit: "b4b356554798716ceaeab74efdc095782be9ca16",
      cliSources: [
        "packages/cli/src/commands/release/create.ts",
        "packages/cli/src/commands/release/finalize.ts",
        "packages/cli/src/commands/release/deploy.ts",
        "packages/cli/src/commands/release/deploys.ts",
      ],
      backendSources: [
        "src/sentry/api/endpoints/organization_releases.py",
        "src/sentry/releases/endpoints/organization_release_details.py",
        "src/sentry/releases/endpoints/release_deploys.py",
      ],
    },
    snapshot() {
      return structuredClone({
        releases: [...releases.values()],
        deploys,
        requests: api.requests,
      });
    },
    reset() {
      releases = new Map([[seedRelease.version, structuredClone(seedRelease)]]);
      deploys = [structuredClone(seedDeploy)];
      nextReleaseId = 201;
      nextDeployId = 601;
      deployResponseLost = false;
      api.requests.length = 0;
    },
    verify(text: string) {
      assert.deepEqual(
        releases.get(seedRelease.version),
        seedRelease,
        "Existing release changed",
      );
      assert.deepEqual(deploys[0], seedDeploy, "Existing deployment changed");
      assert.equal(releases.size, 2, "Expected exactly one new release");
      const release = releases.get(VERSION);
      assert(release, "Requested release is missing");
      assert.deepEqual(
        release.projects.map((project) => project.slug).sort(),
        ["backend", "frontend"],
        "Release projects differ",
      );
      assert.equal(
        release.dateReleased,
        RELEASED,
        "Release was not finalized at the requested time",
      );
      assert.equal(deploys.length, 2, "Expected exactly one new deployment");
      const saved = deploys[1];
      assert.equal(
        saved.releaseVersion,
        VERSION,
        "Deployment belongs to the wrong release",
      );
      assert.deepEqual(
        [...saved.projectSlugs].sort(),
        ["backend", "frontend"],
        "Deployment projects differ",
      );
      assert.deepEqual(
        saved.deploy,
        {
          id: saved.deploy.id,
          environment: "staging",
          name: DEPLOY_NAME,
          url: DEPLOY_URL,
          dateStarted: STARTED,
          dateFinished: FINISHED,
        },
        "Deployment configuration differs",
      );
      const answer = answerSchema.parse(parseEvalJsonAnswer(text));
      assert.equal(
        answer.version,
        release.version,
        "Final answer reports the wrong release version",
      );
      assert.deepEqual(
        [...answer.projects].sort(),
        release.projects.map((project) => project.slug).sort(),
        "Final answer reports incorrect release projects",
      );
      assert.equal(
        answer.dateReleased,
        release.dateReleased,
        "Final answer reports an incorrect release time",
      );
      assert.equal(
        answer.deploymentId,
        saved.deploy.id,
        "Final answer does not report the actual deployment ID",
      );
      return {
        success: true as const,
        releaseVersion: VERSION,
        deployId: saved.deploy.id,
      };
    },
    close: api.close,
  };
}
