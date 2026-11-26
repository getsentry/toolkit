/**
 * Pick the Sentry project a setup wizard configures, with the CLI's login.
 *
 * The old wizard opened `account/settings/wizard/<hash>/` in a browser and
 * polled for the projects and an auth token. This module uses what the rest
 * of the CLI uses instead:
 *
 * - The stored `sentry auth login` account, or a new device-flow login (or an
 *   agent handoff from `SENTRY_HANDOFF`) when there is none. A new login asks
 *   for `org:tokens` and `org:ci` too, so the auth token below needs no second
 *   approval.
 * - The org from `--org`, the handoff, or a prompt; then the project from
 *   `--project` or a prompt that can also create one for the wizard's
 *   platform, like the old browser page could.
 * - The project's DSN from its client keys.
 * - A new org auth token for the build plugins and `sentry` commands that
 *   upload source maps and debug files. When the token can't be created, a
 *   placeholder goes in its place and the user is told where to make one.
 */

import chalk from "chalk";
import { completeAgentHandoff } from "../../agent-handoff.js";
import {
  getProject,
  getProjectKeys,
  listProjects,
} from "../../api/projects.js";
import { createOrgAuthToken } from "../../api/org-auth-tokens.js";
import { listOrganizations } from "../../api/organizations.js";
import {
  createProjectWithAutoTeam,
  createProjectWithDsn,
  MEMBER_PROJECT_CREATION_DISABLED_DETAIL,
} from "../../api/projects.js";
import { assertAutoLoginHostTrusted } from "../../auto-auth.js";
import { DEFAULT_SENTRY_URL } from "../../constants.js";
import { getAuthConfig } from "../../db/auth.js";
import { getEnv } from "../../env.js";
import { ApiError } from "../../errors.js";
import { runInteractiveLogin } from "../../interactive-login.js";
import { logger } from "../../logger.js";
import { OAUTH_SCOPES, resolveOAuthScopeString } from "../../oauth.js";
import { resolveOrCreateTeam } from "../../resolve-team.js";
import { ensureScopesForAction } from "../../scope-recovery.js";
import { isSentrySaasUrl } from "../../sentry-urls.js";
import { getApiBaseUrl } from "../../sentry-client.js";
import {
  isRequestOriginTrusted,
  registerLoginTrustAnchor,
} from "../../token-host.js";
import { slugify } from "../../utils.js";
import { sentry } from "../../app-identity.js";
import type {
  SentryOrganization,
  SentryProject,
} from "../../../types/sentry.js";
import { Sentry, traceStep } from "../telemetry.js";
import { abort, abortIfCancelled } from "./clack/index.js";
import { clack } from "./clack/prompts.js";
import type { SentryProjectData, WizardOptions } from "./types.js";

const log = logger.withTag("wizard");

/** Written in place of an auth token that couldn't be created. */
export const DUMMY_AUTH_TOKEN = "_YOUR_SENTRY_AUTH_TOKEN_";

/** Scopes an org auth token request needs from the CLI's OAuth grant. */
const TOKEN_SCOPES = ["org:tokens", "org:read", "org:ci"] as const;

/** `value` of the project picker's "create a new project" option. */
const CREATE_PROJECT = Symbol("create-project");

/** Sentry platform identifiers of the wizards, used for new projects. */
export type WizardPlatform =
  | "javascript-angular"
  | "javascript-nextjs"
  | "javascript-nuxt"
  | "javascript-react-router"
  | "javascript-remix"
  | "javascript-sveltekit"
  | "node-cloudflare-workers"
  | "apple-ios"
  | "android"
  | "react-native"
  | "flutter";

/** The project a wizard sets up, or Spotlight mode, which needs none. */
export type WizardProjectData =
  | {
      /** Web URL of the Sentry instance, ending in `/`. */
      sentryUrl: string;
      selfHosted: boolean;
      selectedProject: SentryProjectData;
      /** Org auth token, or {@link DUMMY_AUTH_TOKEN}. */
      authToken: string;
      spotlight: false;
    }
  | {
      spotlight: true;
    };

/**
 * Get the Sentry project for a wizard run: the one passed in
 * `options.preSelectedProject`, or one the user picks (or creates) after
 * logging in.
 *
 * @param options - Wizard options (`--url`, `--saas`, `--org`, `--project`, …)
 * @param platform - Platform for a project the user creates
 */
export async function getOrAskForProjectData(
  options: WizardOptions,
  platform?: WizardPlatform,
): Promise<WizardProjectData> {
  if (options.spotlight) {
    clack.log.info(
      `Spotlight mode enabled! Setting up for local development without Sentry account needed.\n
        Note: Your app will only send data to the local Spotlight debugger, not to Sentry.`,
    );
    return { spotlight: true };
  }

  if (options.preSelectedProject) {
    return {
      selfHosted: options.preSelectedProject.selfHosted,
      sentryUrl: withTrailingSlash(options.url ?? DEFAULT_SENTRY_URL),
      authToken: options.preSelectedProject.authToken,
      selectedProject: options.preSelectedProject.project,
      spotlight: false,
    };
  }

  await traceStep("ask-self-hosted", () =>
    selectSentryUrl(options.url, options.saas),
  );
  const handoffOrg = await traceStep("login", ensureLoggedIn);

  // The chosen instance, or the stored login's when none was chosen.
  const sentryUrl = withTrailingSlash(getApiBaseUrl());
  const selfHosted = !isSentrySaasUrl(sentryUrl);
  Sentry.setTag("url", sentryUrl);
  Sentry.setTag("self-hosted", selfHosted);

  const org = await traceStep("select-org", () =>
    selectOrganization(options.orgSlug ?? handoffOrg),
  );
  const project = await traceStep("select-project", () =>
    selectProject(org, options.projectSlug, platform),
  );
  Sentry.setTag("project", project.slug);
  Sentry.setUser({ id: org.slug });

  const dsn = await getDsn(org.slug, project.slug);
  const authToken = await traceStep("create-auth-token", () =>
    createAuthToken(org.slug, sentryUrl),
  );

  return {
    sentryUrl,
    selfHosted,
    authToken,
    selectedProject: {
      id: project.id,
      slug: project.slug,
      organization: { id: org.id, name: org.name, slug: org.slug },
      keys: [{ dsn: { public: dsn } }],
    },
    spotlight: false,
  };
}

/**
 * Point this run at the Sentry instance the user chose: SaaS for `--saas`,
 * the `--url` instance, or the answer to a SaaS/self-hosted prompt. Without
 * any of them and with a stored login, the login's instance is used.
 *
 * An instance the user names here (flag or prompt) is trusted for login, the
 * same as `sentry auth login --url`.
 */
async function selectSentryUrl(
  urlFromArgs: string | undefined,
  saas: boolean | undefined,
): Promise<void> {
  if (saas) {
    useSentryUrl(DEFAULT_SENTRY_URL);
    return;
  }
  if (!urlFromArgs && getAuthConfig()) {
    return;
  }

  if (!urlFromArgs) {
    const choice = await abortIfCancelled(
      clack.select({
        message: "Are you using Sentry SaaS or self-hosted Sentry?",
        options: [
          { value: "saas", label: "Sentry SaaS (sentry.io)" },
          {
            value: "self-hosted",
            label: "Self-hosted/on-premise/single-tenant",
          },
        ],
      }),
    );
    if (choice === "saas") {
      useSentryUrl(DEFAULT_SENTRY_URL);
      return;
    }
  }

  let pending = urlFromArgs;
  for (;;) {
    const url =
      pending ||
      (await abortIfCancelled(
        clack.text({
          message: `Please enter the URL of your ${
            urlFromArgs ? "" : "self-hosted "
          }Sentry instance.`,
          placeholder: "https://sentry.io/",
        }),
      ));
    pending = undefined;
    const origin = parseOrigin(url);
    if (origin) {
      useSentryUrl(origin);
      return;
    }
    clack.log.error(
      `Please enter a valid URL. (It should look something like "https://sentry.mydomain.com/", got ${url})`,
    );
  }
}

/** The origin of `url`, or `undefined` when it isn't an HTTP(S) URL. */
function parseOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.origin
      : undefined;
  } catch (error) {
    log.debug(`Invalid Sentry URL ${url}`, error);
    return;
  }
}

/** Send this run's API requests and login to `url`, trusted as user input. */
function useSentryUrl(url: string): void {
  const env = getEnv();
  env["SENTRY_HOST"] = url;
  env["SENTRY_URL"] = url;
  registerLoginTrustAnchor(url);
}

/**
 * Make sure the CLI has a login for the selected instance: claim the agent
 * handoff in `SENTRY_HANDOFF`, keep a stored login, or run the device flow.
 *
 * @returns The org slug of a claimed handoff
 */
async function ensureLoggedIn(): Promise<string | undefined> {
  const handoffCode = getEnv()["SENTRY_HANDOFF"]?.trim();
  if (handoffCode) {
    const handoff = await completeAgentHandoff(handoffCode);
    Sentry.setTag("login-method", "handoff");
    return handoff.organizationSlug;
  }

  // A login for another instance than the selected one can't be used.
  if (getAuthConfig() && isRequestOriginTrusted(getApiBaseUrl())) {
    Sentry.setTag("login-method", "stored");
    return;
  }

  assertAutoLoginHostTrusted();
  clack.log.info(
    `${chalk.bold("Log in to Sentry")} to pick the project to set up. No account yet? You can sign up on the page that opens.`,
  );
  const login = await runInteractiveLogin({
    scope: resolveOAuthScopeString({
      scopes: [...OAUTH_SCOPES, ...TOKEN_SCOPES],
    }),
  });
  if (!login) {
    Sentry.setTag("login-method", "failed");
    return await abort(
      `Please restart the wizard and log in to complete the setup. You can also log in first with ${chalk.cyan(sentry`auth login`)}.`,
    );
  }
  Sentry.setTag("login-method", "device-flow");
  return;
}

/**
 * The organization to set up: `slug` when given, the only one the user
 * belongs to, or the one they pick.
 */
async function selectOrganization(
  slug: string | undefined,
): Promise<Required<Pick<SentryOrganization, "id" | "slug" | "name">>> {
  const orgs = await listOrganizations();
  if (slug) {
    const match = orgs.find((org) => org.slug === slug);
    if (match) {
      clack.log.step(`Selected organization ${chalk.cyan(match.slug)}`);
      return match;
    }
    clack.log.warn(
      `Could not find an organization with the slug ${chalk.cyan(slug)}.`,
    );
  }

  const [only] = orgs;
  if (orgs.length === 1 && only) {
    clack.log.step(`Selected organization ${chalk.cyan(only.slug)}`);
    return only;
  }
  if (!only) {
    Sentry.setTag("no-orgs-found", true);
    return await abort(
      "Your Sentry account has no organizations. Create one in Sentry and run the wizard again.",
    );
  }

  return await abortIfCancelled(
    clack.select({
      maxItems: 12,
      message: "Select your Sentry organization.",
      options: [...orgs]
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((org) => ({ value: org, label: org.slug, hint: org.name })),
    }),
  );
}

/**
 * The project to set up: `slug` when given and found, else the one the user
 * picks from the org's projects or creates.
 */
async function selectProject(
  org: { slug: string },
  slug: string | undefined,
  platform: WizardPlatform | undefined,
): Promise<SentryProject> {
  if (slug) {
    try {
      const project = await getProject(org.slug, slug);
      clack.log.step(
        `Selected project ${chalk.cyan(`${org.slug}/${project.slug}`)}`,
      );
      return project;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        throw error;
      }
      clack.log.warn("Could not find a project with the provided slugs.");
    }
  }

  const projects = (await listProjects(org.slug)).sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  const selection = await abortIfCancelled(
    clack.select<SentryProject | typeof CREATE_PROJECT>({
      maxItems: 12,
      message: "Select your Sentry project.",
      options: [
        { value: CREATE_PROJECT, label: "Create a new project" },
        ...projects.map((project) => ({
          value: project,
          label: `${org.slug}/${project.slug}`,
          ...(project.platform ? { hint: project.platform } : {}),
        })),
      ],
      ...(projects.length > 0 ? { initialValue: projects[0] } : {}),
    }),
  );
  if (typeof selection !== "symbol") {
    return selection;
  }
  Sentry.setTag("created-project", true);
  return await createProject(org.slug, platform);
}

/**
 * Ask for a name and create a project for `platform` in `orgSlug`, on the
 * team the CLI's `project create` would pick. Members who can't use that
 * team get a project on their personal team.
 */
async function createProject(
  orgSlug: string,
  platform: WizardPlatform | undefined,
): Promise<SentryProject> {
  const name = await abortIfCancelled(
    clack.text({
      message: "What should the new project be called?",
      initialValue: slugify(process.cwd().split(/[\\/]/).pop() ?? ""),
      validate: (value) =>
        value.trim() ? undefined : "Please enter a project name.",
    }),
  );
  const body = { name: name.trim(), ...(platform ? { platform } : {}) };

  const spinner = clack.spinner();
  spinner.start("Creating your Sentry project");
  try {
    const team = await resolveOrCreateTeam(orgSlug, {
      usageHint: sentry`wizard --org <org>`,
      autoCreateSlug: slugify(body.name),
    });
    const { project } = await createProjectWithDsn(orgSlug, team.slug, body);
    spinner.stop(`Created project ${chalk.cyan(`${orgSlug}/${project.slug}`)}`);
    return project;
  } catch (error) {
    if (
      !(error instanceof ApiError && error.status === 403) ||
      error.detail?.includes(MEMBER_PROJECT_CREATION_DISABLED_DETAIL)
    ) {
      spinner.stop("Could not create the project.");
      throw error;
    }
    log.debug("403 on the team-based flow, using the org-scoped endpoint");
    const { project } = await createProjectWithAutoTeam(orgSlug, body);
    spinner.stop(`Created project ${chalk.cyan(`${orgSlug}/${project.slug}`)}`);
    return project;
  }
}

/** The public DSN of the project's first active client key. */
async function getDsn(orgSlug: string, projectSlug: string): Promise<string> {
  const keys = await getProjectKeys(orgSlug, projectSlug);
  const key = keys.find((k) => k.isActive) ?? keys[0];
  if (!key) {
    return await abort(
      `The project ${orgSlug}/${projectSlug} has no client keys (DSNs). Create one in its settings and run the wizard again.`,
    );
  }
  return key.dsn.public;
}

/**
 * Create an org auth token for uploading source maps and debug files, or
 * return {@link DUMMY_AUTH_TOKEN} with instructions when that isn't possible
 * (an old login without `org:tokens` in a non-interactive run, no permission,
 * or a server that can't create tokens).
 */
async function createAuthToken(
  orgSlug: string,
  sentryUrl: string,
): Promise<string> {
  try {
    const elevation = await ensureScopesForAction(
      TOKEN_SCOPES,
      "Creating an auth token for uploading source maps",
      runInteractiveLogin,
    );
    if (elevation !== "declined" && elevation !== "unavailable") {
      const token = await createOrgAuthToken(
        orgSlug,
        `Sentry Wizard ${new Date().toISOString().slice(0, 10)}`,
      );
      if (token.token) {
        return token.token;
      }
    }
  } catch (error) {
    log.debug("Could not create an org auth token", error);
  }

  Sentry.setTag("auth-token-created", false);
  const settingsUrl = isSentrySaasUrl(sentryUrl)
    ? `https://${orgSlug}.sentry.io/settings/auth-tokens/`
    : `${sentryUrl}settings/${orgSlug}/auth-tokens/`;
  clack.log.warn(
    `Could not create an auth token for you. We'll add a placeholder (${chalk.cyan(
      `"${DUMMY_AUTH_TOKEN}"`,
    )}) for you to replace later.\nCreate your auth token here:\n${chalk.cyan(settingsUrl)}`,
  );
  return DUMMY_AUTH_TOKEN;
}

/** `url` with exactly one trailing `/`, the form the wizards expect. */
function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
