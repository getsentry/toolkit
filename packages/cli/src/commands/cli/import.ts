/**
 * `sentry cli import` — Import settings from legacy `.sentryclirc` files.
 *
 * Scans for `.sentryclirc` config files (used by the old Rust-based sentry-cli)
 * and imports their settings into the new CLI's SQLite store with proper host
 * scoping.
 *
 * Security: Trust is content-based (same-file rule), not path-based. Token and
 * URL must originate from the same file for the import to proceed without
 * explicit `--url` confirmation. See `sentryclirc-import.ts` for details.
 */

import { isatty } from "node:tty";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { getDefaultUrl } from "../../lib/db/defaults.js";
import { HostScopeError, ValidationError } from "../../lib/errors.js";
import { success, warning } from "../../lib/formatters/colors.js";
import { renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import {
  isSaaSTrustOrigin,
  normalizeUserInputToOrigin,
} from "../../lib/sentry-urls.js";
import type {
  DiscoveredRcFile,
  ImportPlan,
  ImportResult,
} from "../../lib/sentryclirc-import.js";
import {
  buildImportPlan,
  checkSntrysClaim,
  clearImportDecline,
  discoverRcFiles,
  executeImport,
  markImportCompleted,
  maskToken,
} from "../../lib/sentryclirc-import.js";

const log = logger.withTag("cli.import");

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Format a discovered file's fields for human-readable preview */
function formatFilePreview(file: DiscoveredRcFile): string {
  const lines: string[] = [];
  const locationLabel =
    file.location === "project-local" ? " (project-level)" : "";
  lines.push(`  **${file.path}**${locationLabel}`);
  if (file.token) {
    lines.push(`    Token:   \`${maskToken(file.token)}\``);
  }
  if (file.url) {
    lines.push(`    URL:     ${file.url}`);
  }
  if (file.org) {
    lines.push(`    Org:     ${file.org}`);
  }
  if (file.project) {
    lines.push(`    Project: ${file.project}`);
  }
  return lines.join("\n");
}

/** Format the planned actions for preview */
function formatPlanActions(plan: ImportPlan): string {
  const lines: string[] = [];
  if (plan.newFields.includes("token")) {
    const host = plan.effective.url ?? "https://sentry.io";
    lines.push(`  + Store auth token (host scope: ${host})`);
  }
  if (plan.newFields.includes("url") && plan.effective.url) {
    lines.push(`  + Set default URL: ${plan.effective.url}`);
  }
  if (plan.newFields.includes("org") && plan.effective.org) {
    lines.push(`  + Set default org: ${plan.effective.org}`);
  }
  if (plan.newFields.includes("project") && plan.effective.project) {
    lines.push(`  + Set default project: ${plan.effective.project}`);
  }
  return lines.join("\n");
}

/** Format the full preview shown before confirmation */
function formatPreview(plan: ImportPlan): string {
  const sections: string[] = ["Found .sentryclirc settings:\n"];

  for (const file of plan.sources) {
    if (file.token || file.url || file.org || file.project) {
      sections.push(formatFilePreview(file));
    }
  }

  if (plan.newFields.length > 0) {
    sections.push("\nWill import:");
    sections.push(formatPlanActions(plan));
  }

  for (const warn of plan.warnings) {
    sections.push(`\n${warning(`Warning: ${warn}`)}`);
  }

  return sections.join("\n");
}

/** Format stored fields list for result display */
function formatStoredFields(result: ImportResult): string {
  const stored: string[] = [];
  if (result.stored.token) {
    stored.push("auth token");
  }
  if (result.stored.url) {
    stored.push("default URL");
  }
  if (result.stored.org) {
    stored.push("default org");
  }
  if (result.stored.project) {
    stored.push("default project");
  }
  return stored.join(", ");
}

/** Format the import result for human output */
function formatImportResult(result: ImportResult): string {
  // Check if anything was partially stored (defaults may persist even
  // when token validation fails)
  const stored = formatStoredFields(result);
  const hasPartialResults = !result.imported && stored;

  if (!(result.imported || hasPartialResults)) {
    return result.warnings.join("\n") || "Import was not performed.";
  }

  const lines: string[] = result.imported
    ? [success("Import successful!")]
    : [warning("Import partially completed:")];

  if (result.user?.name || result.user?.email) {
    const parts = [
      result.user.name,
      result.user.email ? `<${result.user.email}>` : "",
    ].filter(Boolean);
    lines.push(`  Logged in as: ${parts.join(" ")}`);
  }

  if (stored) {
    lines.push(`  Stored: ${stored}`);
  }

  if (result.tokenValid === false) {
    lines.push(warning("  Token validation failed."));
  }

  for (const warn of result.warnings) {
    lines.push(warning(`  ${warn}`));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An empty ImportResult for early-exit cases */
function emptyResult(warnings: string[] = []): ImportResult {
  return {
    imported: false,
    stored: { token: false, url: false, org: false, project: false },
    warnings,
  };
}

/**
 * Apply --url override to the plan, marking it trusted and recalculating isSaas.
 * Ensures newFields matches what executeImport will actually do (no preview/execution mismatch).
 */
function applyUrlOverride(plan: ImportPlan, url: string): void {
  plan.effective.url = url;
  plan.effectiveSources.url = plan.effectiveSources.token;
  plan.trusted = true;
  plan.isSaas = isSaaSTrustOrigin(url);

  // Re-check sntrys_ claim against the overridden URL
  if (plan.effective.token) {
    const claimWarning = checkSntrysClaim(plan.effective.token, url);
    if (claimWarning && !plan.warnings.includes(claimWarning)) {
      plan.warnings.push(claimWarning);
    }
  }

  // Remove stale "url" entry if the override makes it SaaS (storeDefaults skips SaaS URLs)
  if (plan.isSaas) {
    plan.newFields = plan.newFields.filter((f) => f !== "url");
    return;
  }
  // Add "url" only if not already listed and no default URL is stored
  if (!plan.newFields.includes("url")) {
    try {
      if (!getDefaultUrl()) {
        plan.newFields.push("url");
      }
    } catch (error) {
      log.debug("Failed to check default URL", error);
      plan.newFields.push("url");
    }
  }
}

/** Enforce the same-file trust gate; throws HostScopeError on violation */
function enforceTrustGate(plan: ImportPlan): void {
  if (plan.trusted) {
    return;
  }
  const tokenSource = plan.effectiveSources.token ?? "unknown";
  const urlSource = plan.effectiveSources.url ?? "unknown";
  throw new HostScopeError(
    `Token (from ${tokenSource}) and URL (from ${urlSource}) come from different files.\n` +
      "To confirm you trust this URL, pass it explicitly:\n" +
      `  sentry cli import --url ${plan.effective.url ?? "<url>"}`
  );
}

/** Prompt for confirmation in interactive mode. Returns true to proceed. */
async function confirmImport(): Promise<boolean> {
  if (!isatty(0)) {
    return false;
  }
  const confirmed = await log.prompt("Import these settings to the new CLI?", {
    type: "confirm",
    initial: true,
  });
  // Symbol(clack:cancel) is truthy — strict equality check
  return confirmed === true;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

type ImportFlags = {
  readonly yes: boolean;
  readonly "dry-run": boolean;
  readonly url?: string;
  readonly "skip-validation": boolean;
};

/** Parse and normalize the --url flag value */
function parseImportUrl(raw: string): string {
  const origin = normalizeUserInputToOrigin(raw);
  if (!origin) {
    throw new ValidationError(`Invalid URL: ${raw}`, "url");
  }
  return origin;
}

export const importCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: "Import settings from legacy .sentryclirc files",
    fullDescription:
      "Scan for .sentryclirc config files (used by the old Rust-based sentry-cli) " +
      "and import their settings into the new CLI.\n\n" +
      "Imported settings:\n" +
      "  - Auth token -> stored credentials (with proper host scoping)\n" +
      "  - URL -> default Sentry instance URL\n" +
      "  - Organization -> default organization\n" +
      "  - Project -> default project\n\n" +
      "Security: token and URL must come from the same file to be trusted.\n" +
      "Cross-file URL requires explicit --url confirmation.\n\n" +
      "Examples:\n" +
      "  sentry cli import               # Scan and import interactively\n" +
      "  sentry cli import --yes         # Auto-confirm (CI-safe)\n" +
      "  sentry cli import --dry-run     # Preview without changes\n" +
      "  sentry cli import --url <url>   # Trust a specific URL",
  },
  parameters: {
    flags: {
      yes: {
        kind: "boolean",
        brief: "Skip confirmation prompt",
        default: false,
      },
      "dry-run": DRY_RUN_FLAG,
      url: {
        kind: "parsed",
        parse: parseImportUrl,
        brief: "Explicitly trust this URL (bypasses same-file trust check)",
        optional: true,
      },
      "skip-validation": {
        kind: "boolean",
        brief: "Skip token validation against the Sentry API",
        default: false,
      },
    },
    aliases: { y: "yes", n: "dry-run" },
  },
  output: { human: formatImportResult },
  async *func(this: SentryContext, flags: ImportFlags) {
    // 1. Discover .sentryclirc files
    const files = await discoverRcFiles(this.cwd);
    if (files.length === 0) {
      yield new CommandOutput(emptyResult(["No .sentryclirc files found."]));
      return;
    }

    // 2. Build import plan (with optional --url override)
    const plan = buildImportPlan(files);
    if (flags.url) {
      applyUrlOverride(plan, flags.url);
    }

    // 3. Nothing to import?
    if (plan.newFields.length === 0) {
      markImportCompleted(plan);
      yield new CommandOutput(
        emptyResult(["All settings from .sentryclirc are already configured."])
      );
      return;
    }

    // 4. Trust gate — only enforce when importing a token with a non-SaaS URL.
    //    Org/project/URL-only defaults are harmless and don't need cross-file trust.
    //    The trust gate protects against redirecting a token to a malicious host,
    //    so it only matters when a token is actually being stored.
    if (!flags.url && plan.newFields.includes("token")) {
      enforceTrustGate(plan);
    }

    // 5. Show preview
    log.info(renderMarkdown(formatPreview(plan)));

    // 6. Dry-run: stop here
    if (flags["dry-run"]) {
      yield new CommandOutput(emptyResult());
      return { hint: "Dry run — no changes made." };
    }

    // 7. Confirm (unless --yes)
    if (!flags.yes) {
      if (!isatty(0)) {
        yield new CommandOutput(
          emptyResult([
            "Import requires confirmation. Use --yes in non-interactive mode.",
          ])
        );
        process.exitCode = 1;
        return;
      }
      if (!(await confirmImport())) {
        log.info("Cancelled.");
        return;
      }
    }

    // 8. Execute import
    const result = await executeImport(plan, {
      validateToken: !flags["skip-validation"],
    });
    // Always clear the decline flag when the user explicitly runs import —
    // even if validation fails. This lets the auto-prompt re-offer on the
    // next auth error (with fresh hash evaluation).
    clearImportDecline();
    yield new CommandOutput(result);

    if (result.tokenValid === false) {
      return {
        hint: "Token validation failed. Check your token and try: sentry auth login",
      };
    }
    if (result.imported) {
      return {
        hint: "Your .sentryclirc file is still active via the env shim. You can remove it once you've verified everything works.",
      };
    }
  },
});
