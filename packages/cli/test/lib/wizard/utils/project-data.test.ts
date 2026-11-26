/**
 * Tests for the wizards' project selection on top of the CLI's login.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  runInteractiveLogin: vi.fn(),
  completeAgentHandoff: vi.fn(),
  ensureScopesForAction: vi.fn(),
  listOrganizations: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  getProjectKeys: vi.fn(),
  createProjectWithDsn: vi.fn(),
  createProjectWithAutoTeam: vi.fn(),
  resolveOrCreateTeam: vi.fn(),
  createOrgAuthToken: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  outro: vi.fn(),
  select: mocks.select,
  text: mocks.text,
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: {
    info: vi.fn(),
    step: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../../../src/lib/db/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/lib/db/auth.js")>()),
  getAuthConfig: mocks.getAuthConfig,
}));
vi.mock("../../../../src/lib/interactive-login.js", () => ({
  runInteractiveLogin: mocks.runInteractiveLogin,
}));
vi.mock("../../../../src/lib/agent-handoff.js", () => ({
  completeAgentHandoff: mocks.completeAgentHandoff,
}));
vi.mock("../../../../src/lib/auto-auth.js", () => ({
  assertAutoLoginHostTrusted: vi.fn(),
}));
vi.mock("../../../../src/lib/scope-recovery.js", () => ({
  ensureScopesForAction: mocks.ensureScopesForAction,
}));
vi.mock("../../../../src/lib/api/organizations.js", () => ({
  listOrganizations: mocks.listOrganizations,
}));
vi.mock("../../../../src/lib/api/org-auth-tokens.js", () => ({
  createOrgAuthToken: mocks.createOrgAuthToken,
}));
vi.mock("../../../../src/lib/resolve-team.js", () => ({
  resolveOrCreateTeam: mocks.resolveOrCreateTeam,
}));
vi.mock("../../../../src/lib/api/projects.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/lib/api/projects.js")
  >()),
  listProjects: mocks.listProjects,
  getProject: mocks.getProject,
  getProjectKeys: mocks.getProjectKeys,
  createProjectWithDsn: mocks.createProjectWithDsn,
  createProjectWithAutoTeam: mocks.createProjectWithAutoTeam,
}));

import { ApiError, WizardExitError } from "../../../../src/lib/errors.js";
import {
  DUMMY_AUTH_TOKEN,
  getOrAskForProjectData,
} from "../../../../src/lib/wizard/utils/project-data.js";
import type { SentryProjectData } from "../../../../src/lib/wizard/utils/types.js";

const ORG = { id: "1", slug: "acme", name: "Acme" };
const PROJECT = { id: "42", slug: "web", name: "web", platform: "javascript" };
const KEY = {
  id: "k1",
  name: "Default",
  isActive: true,
  dsn: { public: "https://abc@o1.ingest.sentry.io/42", secret: "" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SENTRY_HANDOFF", "");
  mocks.getAuthConfig.mockReturnValue({ token: "stored" });
  mocks.listOrganizations.mockResolvedValue([ORG]);
  mocks.getProject.mockResolvedValue(PROJECT);
  mocks.getProjectKeys.mockResolvedValue([KEY]);
  mocks.ensureScopesForAction.mockResolvedValue("ready");
  mocks.createOrgAuthToken.mockResolvedValue({ token: "sntrys_new" });
});

describe("getOrAskForProjectData", () => {
  it("needs no login in Spotlight mode", async () => {
    const result = await getOrAskForProjectData({
      telemetryEnabled: false,
      spotlight: true,
    });

    expect(result).toEqual({ spotlight: true });
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
  });

  it("returns a preselected project without asking", async () => {
    const project: SentryProjectData = {
      id: "7",
      slug: "app",
      organization: { id: "1", name: "Acme", slug: "acme" },
      keys: [{ dsn: { public: "https://k@sentry.io/7" } }],
    };

    const result = await getOrAskForProjectData({
      telemetryEnabled: false,
      preSelectedProject: { project, authToken: "tok", selfHosted: false },
    });

    expect(result).toEqual({
      spotlight: false,
      selfHosted: false,
      sentryUrl: "https://sentry.io/",
      authToken: "tok",
      selectedProject: project,
    });
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
  });

  it("uses the stored login and the --org and --project slugs", async () => {
    const result = await getOrAskForProjectData({
      telemetryEnabled: false,
      saas: true,
      orgSlug: "acme",
      projectSlug: "web",
    });

    expect(mocks.runInteractiveLogin).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.getProject).toHaveBeenCalledWith("acme", "web");
    expect(result).toEqual({
      spotlight: false,
      selfHosted: false,
      sentryUrl: "https://sentry.io/",
      authToken: "sntrys_new",
      selectedProject: {
        id: "42",
        slug: "web",
        organization: ORG,
        keys: [{ dsn: { public: KEY.dsn.public } }],
      },
    });
  });

  it("asks for the project when the --project slug is not found", async () => {
    mocks.getProject.mockRejectedValue(new ApiError("Not found", 404));
    mocks.listProjects.mockResolvedValue([PROJECT]);
    mocks.select.mockResolvedValueOnce(PROJECT);

    const result = await getOrAskForProjectData({
      telemetryEnabled: false,
      saas: true,
      orgSlug: "acme",
      projectSlug: "missing",
    });

    expect(mocks.listProjects).toHaveBeenCalledWith("acme");
    expect(result).toMatchObject({ selectedProject: { slug: "web" } });
  });

  it("creates a project for the wizard's platform", async () => {
    mocks.listProjects.mockResolvedValue([]);
    mocks.select.mockImplementationOnce(
      (options: { options: { value: unknown }[] }) =>
        Promise.resolve(options.options[0]?.value),
    );
    mocks.text.mockResolvedValueOnce("my app");
    mocks.resolveOrCreateTeam.mockResolvedValue({ slug: "acme" });
    mocks.createProjectWithDsn.mockResolvedValue({
      project: { ...PROJECT, slug: "my-app" },
    });

    const result = await getOrAskForProjectData(
      { telemetryEnabled: false, saas: true, orgSlug: "acme" },
      "javascript-nextjs",
    );

    expect(mocks.createProjectWithDsn).toHaveBeenCalledWith("acme", "acme", {
      name: "my app",
      platform: "javascript-nextjs",
    });
    expect(result).toMatchObject({ selectedProject: { slug: "my-app" } });
  });

  it("writes a placeholder token when no auth token can be created", async () => {
    mocks.ensureScopesForAction.mockResolvedValue("unavailable");

    const result = await getOrAskForProjectData({
      telemetryEnabled: false,
      saas: true,
      orgSlug: "acme",
      projectSlug: "web",
    });

    expect(mocks.createOrgAuthToken).not.toHaveBeenCalled();
    expect(result).toMatchObject({ authToken: DUMMY_AUTH_TOKEN });
  });

  it("logs in with the device flow when there is no stored login", async () => {
    mocks.getAuthConfig.mockReturnValue(undefined);
    mocks.runInteractiveLogin.mockResolvedValue({ method: "oauth" });

    await getOrAskForProjectData({
      telemetryEnabled: false,
      saas: true,
      orgSlug: "acme",
      projectSlug: "web",
    });

    expect(mocks.runInteractiveLogin).toHaveBeenCalledWith({
      scope: expect.stringContaining("org:tokens"),
    });
  });

  it("stops when the login fails", async () => {
    mocks.getAuthConfig.mockReturnValue(undefined);
    mocks.runInteractiveLogin.mockResolvedValue(null);

    await expect(
      getOrAskForProjectData({ telemetryEnabled: false, saas: true }),
    ).rejects.toThrow(WizardExitError);
  });

  it("claims an agent handoff and uses its org", async () => {
    vi.stubEnv("SENTRY_HANDOFF", "handoff-code");
    mocks.completeAgentHandoff.mockResolvedValue({ organizationSlug: "acme" });

    await getOrAskForProjectData({
      telemetryEnabled: false,
      saas: true,
      projectSlug: "web",
    });

    expect(mocks.completeAgentHandoff).toHaveBeenCalledWith("handoff-code");
    expect(mocks.getProject).toHaveBeenCalledWith("acme", "web");
  });
});
