import type { SentryTeam } from "../../types/index.js";
import {
  getOrganization,
  listOrganizations,
  listTeams,
} from "../api-client.js";
import { getAuthToken } from "../db/auth.js";
import { ApiError, AuthError, HostScopeError, WizardError } from "../errors.js";
import { buildOrgNotFoundError, resolveOrCreateTeam } from "../resolve-team.js";
import { captureOAuthScopeRecoveryGate } from "../scope-recovery.js";
import { slugify } from "../utils.js";
import { WizardCancelledError } from "./clack-utils.js";
import { tryGetExistingProjectData } from "./existing-project.js";
import { resolveOrgPrefetched } from "./org-prefetch.js";
import { formatMemberProjectCreationDisabledError } from "./project-creation-errors.js";
import type {
  ExistingProjectData,
  ResolvedInitContext,
  WizardOptions,
} from "./types.js";
import { isCancelled, type WizardUI } from "./ui/types.js";

const NUMERIC_ORG_ID_RE = /^\d+$/;

type ExistingProjectChoice = {
  project?: string;
  existingProject?: ExistingProjectData;
  shouldAbort?: boolean;
};

type InitContextSeed = {
  org?: string;
  project?: string;
  existingProject?: ExistingProjectData;
};

type ProjectSelection = Pick<
  ResolvedInitContext,
  "project" | "existingProject"
>;

/**
 * Resolve org, project, team, and auth state before the init workflow starts.
 */
export async function resolveInitContext(
  initial: WizardOptions,
  ui: WizardUI
): Promise<ResolvedInitContext | null> {
  return await withPreflightHandling(ui, async () => {
    const seed = await resolveInitContextSeed(initial, ui);
    if (!seed) {
      return null;
    }

    const org = await ensureOrg(seed.org, initial, ui);
    const projectSelection = await resolveProjectSelection(
      org,
      initial,
      seed,
      ui
    );
    if (!projectSelection) {
      return null;
    }

    const team = await resolveTeam(org, initial, ui);

    return buildResolvedInitContext(initial, org, team, projectSelection);
  });
}

async function withPreflightHandling(
  ui: WizardUI,
  action: () => Promise<ResolvedInitContext | null>
): Promise<ResolvedInitContext | null> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      ui.cancel("Setup cancelled.");
      ui.feedback("cancelled");
      process.exitCode = 0;
      return null;
    }

    if (
      error instanceof AuthError ||
      error instanceof HostScopeError ||
      (error instanceof ApiError &&
        (error.status === 401 || error.status === 403))
    ) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    ui.log.error(message);
    ui.cancel("Setup failed.");
    ui.feedback("failed");
    throw error instanceof WizardError ? error : new WizardError(message);
  }
}

function buildResolvedInitContext(
  initial: WizardOptions,
  org: string,
  team: string | undefined,
  selection: ProjectSelection
): ResolvedInitContext {
  return {
    directory: initial.directory,
    yes: initial.yes,
    dryRun: initial.dryRun,
    features: initial.features,
    org,
    team,
    isExplicitTeam: Boolean(initial.team),
    project: selection.project,
    app: initial.app,
    authToken: getAuthToken(),
    existingProject: selection.existingProject,
  };
}

async function resolveInitContextSeed(
  initial: WizardOptions,
  ui: WizardUI
): Promise<InitContextSeed | null> {
  const detected = await resolveDetectedProject(initial, ui);
  if (detected?.shouldAbort) {
    return null;
  }

  return {
    org: detected?.org ?? initial.org,
    project: detected?.project ?? initial.project,
    existingProject: detected?.existingProject,
  };
}

async function ensureOrg(
  org: string | undefined,
  initial: WizardOptions,
  ui: WizardUI
): Promise<string> {
  if (org) {
    return org;
  }

  const orgResult = await resolveOrgSlug(initial.directory, initial.yes, ui);
  if (typeof orgResult === "string") {
    return orgResult;
  }

  throw new WizardError(orgResult.error ?? "Failed to resolve organization.");
}

async function resolveProjectSelection(
  org: string,
  initial: WizardOptions,
  seed: InitContextSeed,
  ui: WizardUI
): Promise<ProjectSelection | null> {
  if (!seed.project) {
    return {
      project: seed.project,
      existingProject: seed.existingProject,
    };
  }

  const resolved = await resolveExistingProjectChoice({
    org,
    project: seed.project,
    existingProject: seed.existingProject,
    yes: initial.yes,
    promptOnExisting: Boolean(initial.project && !initial.org),
    ui,
  });
  if (resolved.shouldAbort) {
    return null;
  }

  return mergeProjectSelection(seed, resolved);
}

function mergeProjectSelection(
  seed: InitContextSeed,
  resolved: ExistingProjectChoice
): ProjectSelection {
  const project = "project" in resolved ? resolved.project : seed.project;
  const clearedProject =
    "project" in resolved && resolved.project === undefined;

  return {
    project,
    existingProject: clearedProject
      ? undefined
      : (resolved.existingProject ?? seed.existingProject),
  };
}

async function resolveDetectedProject(
  initial: WizardOptions,
  ui: WizardUI
): Promise<{
  org?: string;
  project?: string;
  existingProject?: ExistingProjectData;
  shouldAbort?: boolean;
} | null> {
  if (initial.org || initial.project) {
    return null;
  }

  let detectedProject: { orgSlug: string; projectSlug: string } | null = null;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    detectedProject = await detectExistingProject(initial.directory);
  } catch {
    return null;
  }
  if (!detectedProject) {
    return null;
  }

  const existingProject = await tryGetExistingProjectData(
    detectedProject.orgSlug,
    detectedProject.projectSlug
  ).catch(() => null);

  if (initial.yes) {
    return {
      org: detectedProject.orgSlug,
      project: detectedProject.projectSlug,
      ...(existingProject ? { existingProject } : {}),
    };
  }

  const choice = await ui.select<"existing" | "create">({
    message: "Found an existing Sentry project in this codebase.",
    options: [
      {
        value: "existing",
        label: `Use existing project (${detectedProject.orgSlug}/${detectedProject.projectSlug})`,
        hint: "Sentry is already configured here",
      },
      {
        value: "create",
        label: "Create a new Sentry project",
      },
    ],
  });
  if (isCancelled(choice)) {
    throw new WizardCancelledError();
  }
  if (choice === "existing") {
    return {
      org: detectedProject.orgSlug,
      project: detectedProject.projectSlug,
      ...(existingProject ? { existingProject } : {}),
    };
  }

  return {};
}

async function resolveExistingProjectChoice(opts: {
  org: string;
  project: string;
  existingProject?: ExistingProjectData;
  yes: boolean;
  promptOnExisting: boolean;
  ui: WizardUI;
}): Promise<ExistingProjectChoice> {
  const slug = slugify(opts.project);
  if (!slug) {
    return { project: opts.project };
  }

  const existingProject =
    opts.existingProject &&
    opts.existingProject.orgSlug === opts.org &&
    opts.existingProject.projectSlug === slug
      ? opts.existingProject
      : await tryGetExistingProjectData(opts.org, slug).catch(() => null);
  if (!existingProject) {
    return { project: opts.project };
  }

  if (!opts.promptOnExisting || opts.yes) {
    return {
      project: existingProject.projectSlug,
      existingProject,
    };
  }

  const choice = await opts.ui.select<"existing" | "create">({
    message: `Found existing project '${slug}' in ${opts.org}.`,
    options: [
      {
        value: "existing",
        label: `Use existing (${opts.org}/${slug})`,
        hint: "Already configured",
      },
      {
        value: "create",
        label: "Create a new project",
        hint: "Wizard will detect the project name from your codebase",
      },
    ],
  });
  if (isCancelled(choice)) {
    throw new WizardCancelledError();
  }
  if (choice === "create") {
    return { project: undefined };
  }

  return {
    project: existingProject.projectSlug,
    existingProject,
  };
}

/**
 * Normalize a team-resolution failure into a WizardError, preserving an
 * ApiError's enriched detail (e.g. 401 `member-disabled-over-limit`) via
 * format() instead of collapsing to its bare message + status line.
 */
function toPreflightWizardError(error: unknown): WizardError {
  if (error instanceof AuthError || error instanceof HostScopeError) {
    throw error;
  }
  if (error instanceof WizardError) {
    return error;
  }
  if (error instanceof ApiError) {
    return new WizardError(error.format());
  }
  return new WizardError(
    error instanceof Error ? error.message : String(error)
  );
}

async function resolveTeam(
  org: string,
  initial: WizardOptions,
  ui: WizardUI
): Promise<string | undefined> {
  if (!initial.team) {
    return await resolveImplicitTeam(org, initial, ui);
  }

  const scopeRecovery = captureOAuthScopeRecoveryGate();
  try {
    const result = await resolveOrCreateTeam(org, {
      team: initial.team,
      usageHint: "sentry init",
      dryRun: initial.dryRun,
      deferAutoCreateOnEmptyOrg: true,
    });
    return result.source === "deferred" ? undefined : result.slug;
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      throw error;
    }
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403) &&
      (await scopeRecovery.shouldDelegate(error, {
        unattended: initial.yes || initial.dryRun,
      }))
    ) {
      throw error;
    }
    if (error instanceof ApiError && error.status === 403) {
      return;
    }
    throw toPreflightWizardError(error);
  }
}

function canCreateProjectInTeam(team: SentryTeam): boolean {
  return Array.isArray(team.access) && team.access.includes("team:admin");
}

/**
 * Whether the user's access scopes indicate they can create projects
 * regardless of the org's `allowMemberProjectCreation` flag.
 *
 * Sentry's role hierarchy (from server.py SENTRY_ROLES):
 * - member:  project:read only — blocked when flag is disabled
 * - admin:   project:write, project:admin, team:admin — CAN create projects
 * - manager: org:write, project:admin, is_global — CAN create projects
 * - owner:   org:write, org:admin, is_global — CAN create projects
 *
 * The previous check only looked for `org:write`, which excluded org admins
 * who have `project:write` / `project:admin` but not `org:write`.
 */
function canBypassMemberCreationRestriction(access: unknown): boolean {
  if (!Array.isArray(access)) {
    return false;
  }
  return (
    access.includes("org:write") ||
    access.includes("project:admin") ||
    access.includes("project:write")
  );
}

async function assertOrgScopedCreationCanProceed(org: string): Promise<void> {
  let organization: Awaited<ReturnType<typeof getOrganization>>;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    organization = await getOrganization(org);
  } catch {
    // If org details cannot be fetched, let the actual create endpoint surface
    // the precise API error during the project-creation step.
    return;
  }

  if (
    organization.allowMemberProjectCreation === false &&
    !canBypassMemberCreationRestriction(organization.access)
  ) {
    throw new WizardError(formatMemberProjectCreationDisabledError(org));
  }
}

async function listTeamsForImplicitInit(
  org: string,
  unattended: boolean
): Promise<SentryTeam[] | undefined> {
  const scopeRecovery = captureOAuthScopeRecoveryGate();
  try {
    return await listTeams(org);
  } catch (error) {
    // 403 from listTeams means the user cannot inspect team access. Continue
    // without a team so init mirrors onboarding's org-scoped auto-team path.
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403) &&
      (await scopeRecovery.shouldDelegate(error, { unattended }))
    ) {
      throw error;
    }
    if (error instanceof ApiError && error.status === 403) {
      await assertOrgScopedCreationCanProceed(org);
      return;
    }
    if (error instanceof ApiError && error.status === 404) {
      return await buildOrgNotFoundError(org, "sentry init");
    }
    throw toPreflightWizardError(error);
  }
}

async function resolveImplicitTeam(
  org: string,
  initial: WizardOptions,
  ui: WizardUI
): Promise<string | undefined> {
  const teams = await listTeamsForImplicitInit(
    org,
    initial.yes || initial.dryRun
  );
  if (!teams) {
    return;
  }

  const candidateTeams = teams
    .filter(canCreateProjectInTeam)
    .sort((left, right) => left.slug.localeCompare(right.slug));
  if (candidateTeams.length === 0) {
    await assertOrgScopedCreationCanProceed(org);
    return;
  }
  if (candidateTeams.length === 1 || initial.yes) {
    return (candidateTeams[0] as SentryTeam).slug;
  }

  const selected = await ui.select<string>({
    message: "Which team should own this project?",
    options: candidateTeams.map((team) => ({
      value: team.slug,
      label: team.slug,
      ...(team.name !== team.slug ? { hint: team.name } : {}),
    })),
  });
  if (isCancelled(selected)) {
    throw new WizardCancelledError();
  }
  return selected;
}

/**
 * Format a 403/401 ApiError from listOrganizations() into a { ok: false }
 * result, or re-throw if the error is something else.
 *
 * 403: token lacks org:read scope — user can bypass by supplying the org slug
 * directly. 401: token is invalid/expired — supplying an org won't help, only
 * re-authenticating will.
 */
function handleOrgListError(error: unknown): { ok: false; error: string } {
  if (error instanceof ApiError && error.status === 403) {
    const lines: string[] = ["Could not list organizations (403 Forbidden)."];
    if (error.detail) {
      lines.push(error.detail, "");
    }
    lines.push(
      "Specify the org on the command line:  sentry init <org-slug>/",
      "Or set an environment variable:       SENTRY_ORG=<org-slug> sentry init"
    );
    return { ok: false, error: lines.join("\n  ") };
  }
  if (error instanceof ApiError && error.status === 401) {
    const lines: string[] = [
      "Could not list organizations (401 Unauthorized).",
    ];
    if (error.detail) {
      lines.push(error.detail);
    }
    return { ok: false, error: lines.join("\n  ") };
  }
  throw error;
}

async function resolveOrgSlug(
  cwd: string,
  yes: boolean,
  ui: WizardUI
): Promise<string | { ok: false; error: string }> {
  const resolved = await resolveOrgPrefetched(cwd);
  if (resolved && !NUMERIC_ORG_ID_RE.test(resolved.org)) {
    return resolved.org;
  }

  let orgs: Awaited<ReturnType<typeof listOrganizations>>;
  const scopeRecovery = captureOAuthScopeRecoveryGate();
  try {
    orgs = await listOrganizations();
  } catch (error) {
    if (await scopeRecovery.shouldDelegate(error, { unattended: yes })) {
      throw error;
    }
    return handleOrgListError(error);
  }
  orgs.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug)
  );
  if (orgs.length === 0) {
    return {
      ok: false,
      error: "Not authenticated. Run 'sentry auth login' first.",
    };
  }
  if (orgs.length === 1 && orgs[0]) {
    return orgs[0].slug;
  }

  if (yes) {
    const slugs = orgs.map((org) => org.slug).join(", ");
    return {
      ok: false,
      error: [
        `Multiple organizations found (${slugs}).`,
        "Specify one with: sentry init <org-slug>/ [directory]",
        "  or set SENTRY_ORG=<org-slug>",
      ].join("\n"),
    };
  }

  const selected = await ui.select<string>({
    message: "Which organization should the project be created in?",
    options: orgs.map((org) => ({
      value: org.slug,
      label: org.name,
      hint: org.slug,
    })),
  });
  if (isCancelled(selected)) {
    throw new WizardCancelledError();
  }
  return selected;
}

async function detectExistingProject(
  cwd: string
): Promise<{ orgSlug: string; projectSlug: string } | null> {
  const { detectDsn } = await import("../dsn/index.js");
  const dsn = await detectDsn(cwd);
  if (!dsn?.publicKey) {
    return null;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const { resolveDsnByPublicKey } = await import("../resolve-target.js");
    const resolved = await resolveDsnByPublicKey(dsn);
    if (!resolved) {
      return null;
    }
    return {
      orgSlug: resolved.org,
      projectSlug: resolved.project,
    };
  } catch {
    return null;
  }
}
