/**
 * sentry info
 *
 * Print the resolved configuration (server URL, default org/project) and verify
 * authentication. Mirrors the legacy `sentry-cli info`, including the
 * `--config-status-json` machine-readable contract used by external tooling.
 */

import type { SentryContext } from "../context.js";
import { getCurrentUser } from "../lib/api/users.js";
import { buildCommand } from "../lib/command.js";
import { DEFAULT_SENTRY_URL } from "../lib/constants.js";
import { isAuthenticated } from "../lib/db/auth.js";
import {
  getDefaultOrganization,
  getDefaultProject,
  getDefaultUrl,
} from "../lib/db/defaults.js";
import { colorTag, renderMarkdown } from "../lib/formatters/markdown.js";
import { CommandOutput } from "../lib/formatters/output.js";
import { logger } from "../lib/logger.js";

const log = logger.withTag("info");

/**
 * Resolved configuration + auth status.
 *
 * The `config`/`auth`/`have_dsn` fields match the legacy `--config-status-json`
 * contract (snake_case); `user` is an additive convenience for human output.
 */
type InfoStatus = {
  config: {
    org: string | null;
    project: string | null;
    url: string;
  };
  auth: {
    /** Auth method, or `null` when unauthenticated. */
    type: "token" | null;
    /** Whether the credentials were verified against the server. */
    successful: boolean;
  };
  /** Whether a DSN is configured (via `SENTRY_DSN`). */
  have_dsn: boolean;
  /** Identity of the verified user, when available. */
  user?: { email?: string; name?: string };
};

/** Flags accepted by `info`. */
type InfoFlags = {
  "config-status-json"?: boolean;
  "no-defaults"?: boolean;
  json?: boolean;
};

/** Read a non-empty configured value, or `null`. */
function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Gather configuration + verify authentication. */
async function gatherStatus(ctx: SentryContext): Promise<InfoStatus> {
  const url =
    nonEmpty(ctx.env.SENTRY_URL) ?? getDefaultUrl() ?? DEFAULT_SENTRY_URL;
  const org = nonEmpty(ctx.env.SENTRY_ORG) ?? getDefaultOrganization();
  const project = nonEmpty(ctx.env.SENTRY_PROJECT) ?? getDefaultProject();
  const authenticated = isAuthenticated();

  let successful = false;
  let user: InfoStatus["user"];
  if (authenticated) {
    try {
      const info = await getCurrentUser();
      successful = true;
      user = {
        email: info.email ?? undefined,
        name: info.name ?? undefined,
      };
    } catch (err) {
      log.debug("Authentication verification failed", err);
    }
  }

  return {
    config: { org, project, url },
    auth: { type: authenticated ? "token" : null, successful },
    have_dsn: nonEmpty(ctx.env.SENTRY_DSN) !== null,
    user,
  };
}

/** Human-readable rendering of the info status. */
function formatInfo(data: InfoStatus): string {
  const lines: string[] = [
    `${colorTag("muted", "Sentry Server:")} ${data.config.url}`,
    `${colorTag("muted", "Default Organization:")} ${data.config.org ?? "-"}`,
    `${colorTag("muted", "Default Project:")} ${data.config.project ?? "-"}`,
    "",
    colorTag("muted", "Authentication Info:"),
    `  Method: ${data.auth.type ? "Auth Token" : "Unauthorized"}`,
    `  Verified: ${
      data.auth.successful ? colorTag("green", "yes") : colorTag("red", "no")
    }`,
  ];
  if (data.user?.email) {
    lines.push(`  User: ${data.user.email}`);
  }
  return renderMarkdown(lines.join("\n"));
}

export const infoCommand = buildCommand({
  docs: {
    brief: "Print configuration and verify authentication",
    fullDescription:
      "Print the resolved Sentry server URL and default organization/project, " +
      "and verify authentication against the server.\n\n" +
      "Use `--config-status-json` for a machine-readable status dump (for " +
      "external tooling); it always exits 0. Use `--no-defaults` to verify " +
      "only authentication, without requiring a default org/project.",
  },
  // Reports auth status (including "Unauthorized") — must run without auth.
  auth: false,
  output: {
    human: formatInfo,
  },
  parameters: {
    flags: {
      "config-status-json": {
        kind: "boolean",
        brief:
          "Emit configuration + auth status as JSON (for external tooling); always exits 0",
        optional: true,
      },
      "no-defaults": {
        kind: "boolean",
        brief:
          "Verify only authentication, without requiring a default org/project",
        optional: true,
      },
    },
  },
  async *func(this: SentryContext, flags: InfoFlags) {
    const status = await gatherStatus(this);

    // `--config-status-json` is a status *report* for external tools: force
    // JSON output and never fail (matching the legacy contract).
    if (flags["config-status-json"]) {
      flags.json = true;
      yield new CommandOutput(status);
      return;
    }

    yield new CommandOutput(status);

    const missingDefaults = !(
      flags["no-defaults"] ||
      (status.config.org && status.config.project)
    );
    const failed = status.auth.type === null || !status.auth.successful;
    if (failed || missingDefaults) {
      this.process.exitCode = 1;
      return {
        hint: failed
          ? "Not authenticated. Run `sentry auth login`."
          : "No default organization/project. Run `sentry init` or set defaults.",
      };
    }
    return { hint: "Configuration verified." };
  },
});
