/**
 * Output Formatters
 *
 * Translate the raw workflow result into the structured `WizardSummary`
 * the UI implementations render. The previous version assembled
 * terminal-flavored markdown (color tags, an aligned key/value table,
 * a tree of changed files) and pushed it through `ui.log.message`.
 * That worked for `LoggingUI` (which calls `renderMarkdown`) but the
 * earlier TUI showed literal markup like `<yellow>~</yellow>` and
 * pipe-cells because the underlying text primitive couldn't parse
 * markdown — only strip ANSI.
 *
 * Now `formatResult` calls `ui.summary(structuredData)` and lets each
 * implementation decide how to lay it out. `formatError` still uses
 * `ui.log.*` because errors are short enough to live as plain text.
 */

import { basename } from "node:path";
import { terminalLink } from "../formatters/colors.js";
import { stripAnsi } from "../formatters/plain-detect.js";
import {
  buildEventSearchUrl,
  buildProjectIssuesUrl,
  parseOrgProjectFromSettingsUrl,
} from "../sentry-urls.js";
import { featureLabel, sortFeatures } from "./clack-utils.js";
import {
  EXIT_DEPENDENCY_INSTALL_FAILED,
  EXIT_PLATFORM_NOT_DETECTED,
  EXIT_VERIFICATION_FAILED,
  SENTRY_AGENT_INSTALL_COMMAND,
} from "./constants.js";
import type {
  SentryProjectIdentity,
  WizardOutput,
  WorkflowRunResult,
} from "./types.js";
import type { WizardCompletion, WizardSummary, WizardUI } from "./ui/types.js";
import type { VerifyResult } from "./verify-setup.js";

/** Package managers whose dev script we can name for the "start your app" step. */
const KNOWN_PACKAGE_MANAGERS = ["pnpm", "yarn", "bun", "npm"] as const;

/** A genuine Sentry project id is all digits — anything else (e.g. the
 * "(dry-run)" stub) must not be used to scope the Issues stream. */
const NUMERIC_PROJECT_ID = /^\d+$/;

/** Best-effort human name for the project, for the completion header. */
function deriveProjectName(output: WizardOutput): string {
  if (output.projectSlug) {
    return output.projectSlug;
  }
  if (output.projectDir) {
    const base = basename(output.projectDir);
    if (base && base !== "." && base !== "/") {
      return base;
    }
  }
  return "your project";
}

/** Derive a "start your app" command from the install command's package manager. */
function deriveStartCommand(
  commands: string[] | undefined
): string | undefined {
  const first = commands?.[0]?.trim();
  if (!first) {
    return;
  }
  const pm = KNOWN_PACKAGE_MANAGERS.find((p) => first.startsWith(`${p} `));
  if (!pm) {
    return;
  }
  return pm === "npm" ? "npm run dev" : `${pm} dev`;
}

/** Assemble the structured data the interactive completion screen renders. */
function buildCompletion(
  output: WizardOutput,
  verify: VerifyResult | undefined,
  featureBlurbs: { label: string; blurb: string }[]
): WizardCompletion {
  // The server may not hand the org slug back directly (older deploys), so
  // fall back to recovering it from the settings URL it did send. This keeps
  // the Issues link working regardless of server version.
  const parsed = output.sentryProjectUrl
    ? parseOrgProjectFromSettingsUrl(output.sentryProjectUrl)
    : {};
  const orgSlug = output.orgSlug ?? parsed.orgSlug;
  // Only a genuine numeric project id can scope the Issues stream. Guard against
  // non-numeric placeholders — e.g. the "(dry-run)" sentinel from the dry-run
  // project stub — leaking into the URL as `?project=(dry-run)`. A missing id
  // just yields the org-wide Issues stream.
  const projectId = NUMERIC_PROJECT_ID.test(output.projectId ?? "")
    ? output.projectId
    : undefined;
  // Prefer the project-scoped Issues stream (where errors land); fall back to
  // whatever project URL the server sent if we couldn't resolve the org.
  const issuesUrl = orgSlug
    ? buildProjectIssuesUrl(orgSlug, projectId)
    : output.sentryProjectUrl;
  const received = verify?.verified ?? false;
  const eventUrl =
    received && verify?.eventId && orgSlug
      ? buildEventSearchUrl(orgSlug, verify.eventId)
      : undefined;

  return {
    projectName: deriveProjectName(output),
    features: sortFeatures(output.features ?? []).map(featureLabel),
    featureBlurbs,
    changedFileCount: output.changedFiles?.length ?? 0,
    issuesUrl,
    verification: { received, eventUrl },
    agentInstallCommand: SENTRY_AGENT_INSTALL_COMMAND,
    startCommand: deriveStartCommand(output.commands),
  };
}

/**
 * Build the structured summary handed to `ui.summary()`.
 *
 * Returns `null` when there's nothing useful to display — the caller
 * skips the summary call entirely in that case so empty panels don't
 * appear.
 */
function buildSummary(
  output: WizardOutput,
  verify: VerifyResult | undefined
): WizardSummary | null {
  // Resolve blurbs first so the Features row can check the *resolved* length.
  // If the agent returns blurbs with wrong IDs they all drop out here, and
  // the Features row falls back to showing correctly.
  const blurbMap = new Map(
    (output.featureBlurbs ?? []).map(({ feature, blurb }) => [
      feature,
      stripAnsi(blurb),
    ])
  );
  const featureBlurbs = sortFeatures(output.features ?? [])
    .map((feature) => {
      const blurb = blurbMap.get(feature);
      return blurb ? { label: featureLabel(feature), blurb } : null;
    })
    .filter((b): b is { label: string; blurb: string } => b !== null);

  const fields: WizardSummary["fields"] = [];

  if (output.platform) {
    fields.push({ label: "Platform", value: output.platform });
  }
  if (output.projectDir) {
    fields.push({ label: "Directory", value: output.projectDir });
  }
  if (output.features?.length && !featureBlurbs.length) {
    fields.push({
      label: "Features",
      value: output.features.map(featureLabel).join(", "),
    });
  }
  if (output.commands?.length) {
    fields.push({
      label: "Commands",
      value: output.commands.join("; "),
    });
  }
  if (output.sentryProjectUrl) {
    fields.push({ label: "Project", value: output.sentryProjectUrl });
  }
  if (output.docsUrl) {
    fields.push({ label: "Docs", value: output.docsUrl });
  }

  const changedFiles = output.changedFiles ?? [];
  const completion = buildCompletion(output, verify, featureBlurbs);

  const hasContent =
    fields.length > 0 ||
    changedFiles.length > 0 ||
    featureBlurbs.length > 0 ||
    completion.issuesUrl !== undefined ||
    completion.features.length > 0;

  if (!hasContent) {
    return null;
  }

  return {
    fields,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(featureBlurbs.length > 0 ? { featureBlurbs } : {}),
    completion,
  };
}

/**
 * Overlay the locally-captured Sentry project identity onto the workflow output.
 *
 * The CLI creates the project itself, so its captured org/project/projectId are
 * authoritative and take precedence over anything the server echoes back. The
 * server no longer sends these fields (see cli-init-api#239), but keeping the
 * `output.*` fallback means the CLI still works against any server version.
 */
function mergeSentryProjectIdentity(
  output: WizardOutput,
  identity: SentryProjectIdentity | undefined
): WizardOutput {
  if (!identity) {
    return output;
  }
  return {
    ...output,
    orgSlug: identity.orgSlug ?? output.orgSlug,
    projectSlug: identity.projectSlug ?? output.projectSlug,
    projectId: identity.projectId ?? output.projectId,
    sentryProjectUrl: output.sentryProjectUrl ?? identity.url,
  };
}

export function formatResult(
  result: WorkflowRunResult,
  ui: WizardUI,
  verify?: VerifyResult,
  sentryProject?: SentryProjectIdentity
): void {
  const output = mergeSentryProjectIdentity(result.result ?? {}, sentryProject);
  const summary = buildSummary(output, verify);

  if (summary) {
    ui.summary(summary);
  }

  if (output.warnings?.length) {
    for (const w of output.warnings) {
      ui.log.warn(w);
    }
  }

  ui.log.info("Please review the changes above before committing.");

  ui.outro(
    output.message
      ? stripAnsi(output.message)
      : "Sentry SDK installed successfully!"
  );
  ui.feedback("success");
}

export function formatError(result: WorkflowRunResult, ui: WizardUI): void {
  const inner = result.result;
  const message =
    result.error ?? inner?.message ?? "Wizard failed with an unknown error";
  const exitCode = inner?.exitCode ?? 1;

  ui.log.error(String(message));

  if (exitCode === EXIT_PLATFORM_NOT_DETECTED) {
    ui.log.warn(
      "Hint: Could not detect your project's platform. Check that the directory contains a valid project."
    );
  } else if (exitCode === EXIT_DEPENDENCY_INSTALL_FAILED) {
    const commands = inner?.commands;
    if (commands?.length) {
      ui.log.warn(
        `You can install dependencies manually:\n${commands.map((cmd) => `  $ ${cmd}`).join("\n")}`
      );
    }
  } else if (exitCode === EXIT_VERIFICATION_FAILED) {
    ui.log.warn(
      "Hint: Fix the verification issues and run 'sentry init' again."
    );
  }

  const docsUrl = inner?.docsUrl;
  if (docsUrl) {
    ui.log.info(`Docs: ${terminalLink(docsUrl)}`);
  }

  ui.cancel("Setup failed");
  ui.feedback("failed");
}
