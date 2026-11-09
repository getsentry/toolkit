import { describe, expect, it } from "vitest";
import {
  analyzeSourceApiUsage,
  type SourceApiOperation,
} from "../../script/lib/source-api-usage.js";

const operations: SourceApiOperation[] = [
  {
    functionName: "listOrganizationEvents",
    method: "GET",
    path: "/api/0/organizations/{organization_id_or_slug}/events/",
  },
  {
    functionName: "getOrganizationTrace",
    method: "GET",
    path: "/api/0/organizations/{organization_id_or_slug}/trace/{trace_id}/",
  },
  {
    functionName: "deleteProject",
    method: "DELETE",
    path: "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/",
  },
  {
    functionName: "deleteOrganizationWorkflow",
    method: "DELETE",
    path: "/api/0/organizations/{organization_id_or_slug}/workflows/{workflow_id}/",
  },
];

describe("source API usage", () => {
  it("does not treat route-tree inspection as execution of every command", () => {
    const sources = new Map([
      [
        "src/commands/help.ts",
        `
        import { routes } from "../routes.js";
        export const help = buildCommand({ func: () => inspect(routes) });
      `,
      ],
      [
        "src/routes.ts",
        `
        import { remove } from "./commands/project.js";
        export const routes = buildRouteMap({ routes: { remove } });
      `,
      ],
      [
        "src/commands/project.ts",
        `
        import { deleteProject } from "@sentry/api";
        function customWrapper(config) { return buildCommand(config); }
        export const remove = customWrapper({ func: () => deleteProject({}) });
        export const alias = remove;
      `,
      ],
    ]);
    const analysis = analyzeSourceApiUsage(sources, operations);
    expect(analysis.exports.get("src/commands/help.ts")?.get("help")).toEqual({
      operations: [],
      unresolvedRequests: [],
      deletes: false,
    });
    expect(analysis.exports.get("src/routes.ts")?.get("routes")?.deletes).toBe(
      false,
    );
    expect(
      analysis.exports.get("src/commands/project.ts")?.get("remove")?.deletes,
    ).toBe(true);
    expect(
      analysis.exports.get("src/commands/project.ts")?.get("alias")?.deletes,
    ).toBe(true);
  });

  it("follows actual helper calls through aliases and barrels, and grows with new command exports", () => {
    const sources = new Map([
      [
        "src/api.tsx",
        `
        import { listOrganizationEvents as events, getOrganizationTrace } from "@sentry/api";
        export const query = () => events({ query: { dataset: "logs" } });
      `,
      ],
      ["src/barrel.ts", `export { query as read } from "./api.js";`],
      [
        "src/commands/list.ts",
        `
        import { read } from "../barrel.js";
        const customWrapper = (config) => buildCommand(config);
        export const command = customWrapper({ async func() { return await read(); } });
      `,
      ],
    ]);
    const first = analyzeSourceApiUsage(sources, operations);
    expect(
      first.exports.get("src/commands/list.ts")?.get("command")?.operations,
    ).toEqual([{ ...operations[0], query: { dataset: "logs" } }]);

    sources.set(
      "src/api.tsx",
      `
      import { getOrganizationTrace as trace, listOrganizationEvents } from "@sentry/api";
      export const query = () => trace({ path: {} });
    `,
    );
    sources.set("src/commands/new.ts", `export * from "./list.js";`);
    const changed = analyzeSourceApiUsage(sources, operations);
    expect(
      changed.exports.get("src/commands/new.ts")?.get("command")?.operations,
    ).toEqual([operations[1]]);
    expect(changed.commands).toContainEqual({
      file: "src/commands/new.ts",
      name: "command",
      destructive: false,
    });
  });

  it("links regional raw request templates and preserves only known query context", () => {
    const sources = new Map([
      [
        "src/commands/trace.ts",
        `
      import { apiRequestToRegionNoContent as deleteRequest } from "../api.js";
      const DATASET = "spans";
      const TRANSACTIONS = "is_transaction:true";
      async function page(org, options) {
        const fullQuery = [TRANSACTIONS, options.query].filter(Boolean).join(" ");
        return apiRequestToRegion(options.region, \`/organizations/\${org}/events/\`, {
          params: { dataset: DATASET, query: fullQuery || undefined },
        });
      }
      export const list = buildListCommand({ fetchPage: page });
      export const view = buildCommand({ func: (org, id) => apiRequestToRegion("region", \`/organizations/\${org}/trace/\${id}/\`) });
      export const remove = buildDeleteCommand({ func: (org, id) => deleteRequest("region", \`/organizations/\${org}/workflows/\${id}/\`, { method: "DELETE" }) });
    `,
      ],
    ]);
    const result = analyzeSourceApiUsage(sources, operations).exports.get(
      "src/commands/trace.ts",
    )!;
    expect(result.get("list")?.operations).toEqual([
      {
        ...operations[0],
        query: { dataset: "spans", query: "is_transaction:true" },
      },
    ]);
    expect(result.get("view")?.operations).toEqual([operations[1]]);
    expect(result.get("view")?.unresolvedRequests).toEqual([]);
    expect(result.get("remove")).toMatchObject({
      operations: [operations[3]],
      unresolvedRequests: [],
      deletes: true,
    });
  });

  it("does not invent links for dynamic methods, unknown paths or ambiguous catalog templates", () => {
    const sources = new Map([
      [
        "src/commands/raw.ts",
        `
      export const dynamic = buildCommand({ func: (path) => apiRequest(path, { method: "DELETE" }) });
      export const privateApi = buildDeleteCommand({ func: () => apiRequest("/private/", { method: "DELETE" }) });
      export const unknownMethod = buildCommand({ func: (options) => apiRequest("/organizations/any/events/", { ...options }) });
      export const ambiguous = buildCommand({ func: (org) => apiRequest(\`/organizations/\${org}/events/\`) });
    `,
      ],
    ]);
    const analysis = analyzeSourceApiUsage(sources, [
      ...operations,
      {
        ...operations[0]!,
        functionName: "anotherEvents",
        path: "/api/0/organizations/{org}/events/",
      },
    ]);
    const result = analysis.exports.get("src/commands/raw.ts")!;
    expect(result.get("dynamic")).toMatchObject({
      deletes: true,
      operations: [],
      unresolvedRequests: [
        { method: "DELETE", reason: "Dynamic request identity" },
      ],
    });
    expect(result.get("privateApi")).toMatchObject({
      deletes: true,
      operations: [],
      unresolvedRequests: [{ reason: "Request is not in the public catalog" }],
    });
    expect(result.get("unknownMethod")).toMatchObject({
      operations: [],
      unresolvedRequests: [
        { method: undefined, reason: "Dynamic request identity" },
      ],
    });
    expect(result.get("ambiguous")).toMatchObject({
      operations: [],
      unresolvedRequests: [{ reason: "Ambiguous catalog path" }],
    });
    expect(analysis.commands.filter(({ destructive }) => destructive)).toEqual([
      { file: "src/commands/raw.ts", name: "privateApi", destructive: true },
    ]);
  });

  it("keeps SDK DELETE callbacks conservative without following unused imports or shared builder internals", () => {
    const sources = new Map([
      [
        "src/lib/command.ts",
        `import { deleteProject } from "@sentry/api"; export const buildCommand = (config) => { deleteProject({}); return config; };`,
      ],
      [
        "src/commands/project.ts",
        `
        import { buildCommand } from "../lib/command.js";
        import * as sdk from "@sentry/api";
        import { deleteProject } from "@sentry/api";
        export const remove = buildCommand({ destructive: true, func: () => [].map(sdk.deleteProject) });
        export const safe = buildCommand({ func: (deleteProject) => deleteProject() });
      `,
      ],
    ]);
    const analysis = analyzeSourceApiUsage(sources, operations);
    expect(
      analysis.exports.get("src/commands/project.ts")?.get("remove"),
    ).toMatchObject({ operations: [operations[2]], deletes: true });
    expect(
      analysis.exports.get("src/commands/project.ts")?.get("safe"),
    ).toEqual({ operations: [], unresolvedRequests: [], deletes: false });
  });
});
