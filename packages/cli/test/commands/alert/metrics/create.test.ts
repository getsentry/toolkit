import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCommand } from "../../../../src/commands/alert/metrics/create.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../../src/lib/api-client.js";
import { DEFAULT_SENTRY_URL } from "../../../../src/lib/constants.js";
import { setOrgRegion } from "../../../../src/lib/db/regions.js";
import { ValidationError } from "../../../../src/lib/errors.js";
import { useTestConfigDir } from "../../../helpers.js";

const getConfigDir = useTestConfigDir("test-alert-metrics-create-", {
  isolateProjectRoot: true,
});

type CreateFlags = {
  readonly name: string;
  readonly query: string;
  readonly aggregate: string;
  readonly dataset: string;
  readonly "time-window": number;
  readonly trigger?: string[];
  readonly project?: string[];
  readonly environment?: string;
  readonly owner?: string;
  readonly "dry-run": boolean;
  readonly json: boolean;
};

function createContext() {
  const stdoutWrite = vi.fn(() => true);
  return {
    stdout: { write: stdoutWrite },
    stderr: { write: vi.fn(() => true) },
    cwd: getConfigDir(),
    stdoutWrite,
  };
}

describe("alert metrics create", () => {
  let findProjectsBySlugSpy: ReturnType<typeof vi.spyOn>;
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
    findProjectsBySlugSpy.mockImplementation((slug: string) =>
      Promise.resolve({
        projects: [],
        orgs: [{ slug, name: slug }],
      })
    );
    createSpy = vi.spyOn(apiClient, "createMetricAlertRule");
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
    createSpy.mockRestore();
  });

  test("rejects unsupported dataset", async () => {
    const context = createContext();
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(
        context,
        {
          name: "Metric Rule",
          query: "event.type:error",
          aggregate: "count()",
          dataset: "unknown",
          "time-window": 5,
          trigger: ['{"alertThreshold":100,"actions":[{"id":"notify"}]}'],
          "dry-run": true,
          json: true,
        },
        "test-org"
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test.each([
    [
      "blank name",
      { name: "   ", query: "event.type:error", aggregate: "count()" },
    ],
    [
      "blank query",
      { name: "Metric Rule", query: "   ", aggregate: "count()" },
    ],
    [
      "blank aggregate",
      { name: "Metric Rule", query: "event.type:error", aggregate: "   " },
    ],
  ])("rejects %s", async (_, overrides) => {
    const context = createContext();
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(
        context,
        {
          name: overrides.name,
          query: overrides.query,
          aggregate: overrides.aggregate,
          dataset: "errors",
          "time-window": 5,
          trigger: ['{"alertThreshold":100,"actions":[{"id":"notify"}]}'],
          "dry-run": true,
          json: true,
        },
        "test-org"
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects create without a project", async () => {
    const context = createContext();
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await expect(
      func.call(
        context,
        {
          name: "Metric Rule",
          query: "event.type:error",
          aggregate: "count()",
          dataset: "errors",
          "time-window": 5,
          trigger: ['{"alertThreshold":100,"actions":[{"id":"notify"}]}'],
          "dry-run": true,
          json: true,
        },
        "test-org"
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("dry run does not call create API", async () => {
    const context = createContext();
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Metric Rule",
        query: "event.type:error",
        aggregate: "count()",
        dataset: "errors",
        "time-window": 5,
        trigger: ['{"alertThreshold":100,"actions":[{"id":"notify"}]}'],
        project: ["backend"],
        "dry-run": true,
        json: true,
      },
      "test-org"
    );

    expect(createSpy).not.toHaveBeenCalled();
  });

  test("prefers a project over an organization with the same bare slug", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        {
          id: "1",
          slug: "shared",
          name: "Shared Project",
          orgSlug: "project-owner",
        },
      ],
      orgs: [
        { slug: "shared", name: "Shared Org" },
        { slug: "project-owner", name: "Project Owner" },
      ],
    });
    setOrgRegion("project-owner", DEFAULT_SENTRY_URL);
    const context = createContext();
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Metric Rule",
        query: "event.type:error",
        aggregate: "count()",
        dataset: "errors",
        "time-window": 5,
        trigger: ['{"alertThreshold":100,"actions":[{"id":"notify"}]}'],
        project: ["backend"],
        "dry-run": true,
        json: true,
      },
      "shared"
    );

    const output = JSON.parse(
      context.stdoutWrite.mock.calls.map((call) => call[0]).join("")
    );
    expect(output.org).toBe("project-owner");
  });

  test("ignores the project part for metric create org/project targets", async () => {
    const context = createContext();
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Metric Rule",
        query: "event.type:error",
        aggregate: "count()",
        dataset: "errors",
        "time-window": 5,
        trigger: ['{"alertThreshold":100,"actions":[{"id":"notify"}]}'],
        project: ["backend"],
        "dry-run": true,
        json: true,
      },
      "my-org/frontend"
    );

    expect(findProjectsBySlugSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("dry run JSON includes normalized projects and optional fields", async () => {
    const context = createContext();
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Metric Rule",
        query: "event.type:error",
        aggregate: "count()",
        dataset: "errors",
        "time-window": 5,
        trigger: ['{"alertThreshold":100,"actions":[{"id":"notify"}]}'],
        project: ["frontend, backend", "api"],
        environment: "prod",
        owner: "team:ops",
        "dry-run": true,
        json: true,
      },
      "test-org"
    );

    const parsed = JSON.parse(
      context.stdoutWrite.mock.calls.map((c) => c[0]).join("")
    );
    expect(parsed).toEqual({
      org: "test-org",
      name: "Metric Rule",
      dryRun: true,
      body: {
        name: "Metric Rule",
        query: "event.type:error",
        aggregate: "count()",
        dataset: "errors",
        timeWindow: 5,
        triggers: [{ alertThreshold: 100, actions: [{ id: "notify" }] }],
        projects: ["frontend", "backend", "api"],
        environment: "prod",
        owner: "team:ops",
      },
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  test("calls create API with parsed trigger payload", async () => {
    const context = createContext();
    createSpy.mockResolvedValue({
      id: "77",
      name: "Metric Rule",
      status: 0,
    });
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Metric Rule",
        query: "event.type:error",
        aggregate: "count()",
        dataset: "errors",
        "time-window": 5,
        trigger: ['{"alertThreshold":100,"actions":[{"id":"notify"}]}'],
        project: ["backend"],
        "dry-run": false,
        json: true,
      },
      "test-org"
    );

    expect(createSpy).toHaveBeenCalledWith("test-org", {
      name: "Metric Rule",
      query: "event.type:error",
      aggregate: "count()",
      dataset: "errors",
      timeWindow: 5,
      triggers: [{ alertThreshold: 100, actions: [{ id: "notify" }] }],
      projects: ["backend"],
    });
  });

  test("routes --dataset transactions to spans with is_transaction:true and a tip", async () => {
    const context = createContext();
    createSpy.mockResolvedValue({
      id: "77",
      name: "Metric Rule",
      status: 0,
    });
    const func = (await createCommand.loader()) as unknown as (
      this: unknown,
      flags: CreateFlags,
      arg: string
    ) => Promise<void>;

    await func.call(
      context,
      {
        name: "Metric Rule",
        query: "environment:prod",
        aggregate: "p95(span.duration)",
        dataset: "transactions",
        "time-window": 5,
        trigger: ['{"alertThreshold":100,"actions":[{"id":"notify"}]}'],
        project: ["backend"],
        "dry-run": false,
        json: true,
      },
      "test-org"
    );

    expect(createSpy).toHaveBeenCalledWith("test-org", {
      name: "Metric Rule",
      query: "environment:prod is_transaction:true",
      aggregate: "p95(span.duration)",
      dataset: "spans",
      timeWindow: 5,
      triggers: [{ alertThreshold: 100, actions: [{ id: "notify" }] }],
      projects: ["backend"],
    });
    expect(context.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("is_transaction:true")
    );
  });
});
