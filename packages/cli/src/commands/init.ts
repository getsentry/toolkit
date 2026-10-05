/**
 * sentry init
 *
 * Initialize Sentry in a project using the remote wizard workflow.
 * Communicates with the Mastra API via suspend/resume to perform
 * local filesystem operations and interactive prompts.
 *
 * Supports two optional positionals with smart disambiguation:
 *   sentry init                       — auto-detect everything, dir = cwd
 *   sentry init .                     — dir = cwd, auto-detect org
 *   sentry init ./subdir              — dir = subdir, auto-detect org
 *   sentry init acme/                 — explicit org, dir = cwd
 *   sentry init acme/my-app           — explicit org + project, dir = cwd
 *   sentry init my-app                — use existing or create new project
 *   sentry init acme/ ./subdir        — explicit org, dir = subdir
 *   sentry init acme/my-app ./subdir  — explicit org + project, dir = subdir
 *   sentry init ./subdir acme/        — swapped, auto-correct with warning
 */

import path from "node:path";
import { setTag } from "@sentry/node-core/light";
import type { SentryContext } from "../context.js";
import { looksLikePath, parseOrgProjectArg } from "../lib/arg-parsing.js";
import { buildCommand } from "../lib/command.js";
import { refreshToken } from "../lib/db/auth.js";
import { ContextError, ValidationError } from "../lib/errors.js";
import { warmOrgDetection } from "../lib/init/org-prefetch.js";
import { runWizard } from "../lib/init/wizard-runner.js";
import { validateResourceId } from "../lib/input-validation.js";
import { logger } from "../lib/logger.js";
import {
  DRY_RUN_ALIASES,
  DRY_RUN_FLAG,
  YES_ALIASES,
  YES_FLAG,
} from "../lib/mutate-command.js";
import { classifyProjectSearchTarget } from "../lib/resolve-target.js";

const log = logger.withTag("init");

const FEATURE_DELIMITER = /[,+ ]+/;
const NON_INTERACTIVE_USAGE_HINT =
  "sentry init --yes --features errors,tracing,replay [target] [directory]";

// Only features backed by a Sentry SDK selector product are accepted here.
// Non-selector products (source maps, metrics, attachments) are intentionally
// not exposed via --features yet: their setup isn't fully automated — e.g.
// source-map upload needs an auth token this wizard does not provision — so
// accepting them would leave a half-configured integration. Re-add an alias
// (and its SUPPORTED_FEATURE_NAMES entry) once that flow is complete.
const FEATURE_ALIASES = {
  errors: "errorMonitoring",
  errorMonitoring: "errorMonitoring",
  tracing: "performanceMonitoring",
  performanceMonitoring: "performanceMonitoring",
  logs: "logs",
  replay: "sessionReplay",
  sessionReplay: "sessionReplay",
  profiling: "profiling",
  crons: "crons",
  aiMonitoring: "aiMonitoring",
  "agent-tracing": "aiMonitoring",
  agentTracing: "aiMonitoring",
  "mcp-observability": "mcpObservability",
  mcpObservability: "mcpObservability",
} as const;

const SUPPORTED_FEATURE_NAMES = [
  "errors",
  "tracing",
  "logs",
  "replay",
  "profiling",
  "crons",
  "agent-tracing",
  "mcp-observability",
] as const;

const SUPPORTED_FEATURE_TEXT = SUPPORTED_FEATURE_NAMES.join(", ");

type InitFlags = {
  readonly yes: boolean;
  readonly "dry-run": boolean;
  readonly features?: string[];
  readonly team?: string;
  readonly app?: string;
  /**
   * Default `true` — Ink is the default UI on both the Bun binary
   * and the npm/Node distribution. Stricli auto-generates a negated
   * `--no-tui` flag that flips this to `false` — that's the escape
   * hatch users invoke when the Ink path misbehaves (e.g. on unusual
   * terminal emulators).
   */
  readonly tui: boolean;
};

/**
 * Classify and separate two optional positional args into a target and a directory.
 *
 * Uses {@link looksLikePath} to distinguish filesystem paths from org/project targets.
 * Detects swapped arguments and emits a warning when auto-correcting.
 *
 * @returns Resolved target string (or undefined) and directory string (or undefined)
 */
function classifyArgs(
  first?: string,
  second?: string
): { target: string | undefined; directory: string | undefined } {
  // No args — auto-detect everything
  if (!first) {
    return { target: undefined, directory: undefined };
  }

  const firstIsPath = looksLikePath(first);

  // Single arg
  if (!second) {
    return firstIsPath
      ? { target: undefined, directory: first }
      : { target: first, directory: undefined };
  }

  const secondIsPath = looksLikePath(second);

  // Two paths → error
  if (firstIsPath && secondIsPath) {
    throw new ValidationError(
      [
        `"${first}" and "${second}" are both directory paths — only one directory is allowed.`,
        "",
        "Provide a single directory:",
        `  sentry init [<org>/<project>] ${first}`,
      ].join("\n")
    );
  }

  // Two targets → error
  if (!(firstIsPath || secondIsPath)) {
    throw new ValidationError(
      [
        `"${first}" and "${second}" are both treated as targets — only one is allowed.`,
        "",
        "Pair a target with a directory path:",
        `  sentry init ${first} ./my-project`,
      ].join("\n")
    );
  }

  // (TARGET, PATH) — correct order
  if (!firstIsPath && secondIsPath) {
    return { target: first, directory: second };
  }

  // (PATH, TARGET) — swapped, auto-correct with warning
  log.warn(`Arguments appear reversed. Interpreting as: ${second} ${first}`);
  return { target: second, directory: first };
}

function parseFeatures(
  features: readonly string[] | undefined
): string[] | undefined {
  const requested = features
    ?.flatMap((feature) => feature.split(FEATURE_DELIMITER))
    .map((feature) => feature.trim())
    .filter(Boolean);

  if (!requested || requested.length === 0) {
    return;
  }

  return requested.map(normalizeFeature);
}

function normalizeFeature(feature: string): string {
  const normalized = FEATURE_ALIASES[feature as keyof typeof FEATURE_ALIASES];
  if (!normalized) {
    throw new ValidationError(
      `Unknown init feature "${feature}". Supported features: ${SUPPORTED_FEATURE_TEXT}`,
      "features"
    );
  }
  return normalized;
}

function isNonInteractiveContext(context: unknown): boolean {
  const { stdin, stdout } = context as {
    stdin?: { isTTY?: boolean };
    stdout?: { isTTY?: boolean };
  };
  return stdin?.isTTY !== true || stdout?.isTTY !== true;
}

function validateNonInteractiveInit(
  context: unknown,
  flags: InitFlags,
  features: readonly string[] | undefined
): void {
  if (!isNonInteractiveContext(context)) {
    return;
  }

  // --dry-run implies non-interactive mode and forces yes=true in the
  // wizard runner, so it doesn't need explicit --yes or --features.
  if (flags["dry-run"]) {
    return;
  }

  if (flags.yes && features && features.length > 0) {
    return;
  }

  throw new ContextError("Yes flag and features", NON_INTERACTIVE_USAGE_HINT, [
    "Agent/CI mode cannot ask interactive setup questions.",
    "Pass --yes to accept non-interactive prompts.",
    `Pass --features with one or more supported features: ${SUPPORTED_FEATURE_TEXT}.`,
    "Run sentry init from an interactive terminal to use the wizard UI.",
  ]);
}

/**
 * Resolve the parsed org/project target into explicit org and project values.
 *
 * For `project-search` (bare slug), searches for an existing project first.
 * If not found, treats the slug as a **new project name** to create —
 * org will be resolved later by init preflight before the workflow starts.
 * If the slug matches an org name, treats it as org-only (like `slug/`).
 */
async function resolveTarget(targetArg: string | undefined): Promise<{
  org: string | undefined;
  project: string | undefined;
}> {
  const parsed = parseOrgProjectArg(targetArg);

  switch (parsed.type) {
    case "explicit":
      // Validate user-provided slugs before they reach API calls
      validateResourceId(parsed.org, "organization slug");
      validateResourceId(parsed.project, "project name");
      return { org: parsed.org, project: parsed.project };
    case "org-all":
      validateResourceId(parsed.org, "organization slug");
      return { org: parsed.org, project: undefined };
    case "project-search": {
      const resolution = await classifyProjectSearchTarget(parsed, {
        // A miss is a new project name for init, not a fuzzy recovery.
        fuzzy: false,
      });

      // Multiple matches — disambiguation error
      if (resolution.kind === "projects" && resolution.projects.length > 1) {
        const first = resolution.projects[0];
        const orgList = resolution.projects
          .map((p) => `  ${p.orgSlug}/${p.slug}`)
          .join("\n");
        throw new ValidationError(
          `Project "${parsed.projectSlug}" exists in multiple organizations.\n\n` +
            `Specify the organization:\n${orgList}\n\n` +
            `Example: sentry init ${first.orgSlug}/${parsed.projectSlug}`
        );
      }

      // Exactly one match — use it (wizard handles existing-project flow)
      if (resolution.kind === "projects") {
        const match = resolution.projects[0];
        return { org: match.orgSlug, project: match.slug };
      }

      // No project found — is the slug an org name?
      if (resolution.kind === "organization") {
        return { org: resolution.org, project: undefined };
      }

      // Truly not found — treat as the name for a new project to create.
      // Org will be resolved later by init preflight before the workflow starts.
      log.info(
        `No existing project "${parsed.projectSlug}" found — will create a new project with this name.`
      );
      return { org: undefined, project: parsed.projectSlug };
    }
    case "auto-detect":
      return { org: undefined, project: undefined };
    default: {
      const _exhaustive: never = parsed;
      throw new ContextError("Target", String(_exhaustive), []);
    }
  }
}

export const initCommand = buildCommand<
  InitFlags,
  [string?, string?],
  SentryContext
>({
  docs: {
    brief: "Initialize Sentry in your project (experimental)",
    fullDescription:
      "EXPERIMENTAL: This command may modify your source files.\n\n" +
      "Runs the Sentry setup wizard to detect your project's framework, " +
      "install the SDK, and configure Sentry.\n\n" +
      "Supports org/project syntax and a directory positional. Path-like\n" +
      "arguments (starting with . / ~) are treated as the directory;\n" +
      "everything else is treated as the target.\n\n" +
      "Examples:\n" +
      "  sentry init\n" +
      "  sentry init acme/\n" +
      "  sentry init acme/my-app\n" +
      "  sentry init my-app\n" +
      "  sentry init acme/my-app ./my-project\n" +
      "  sentry init ./my-project",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "target",
          brief: "<org>/<project>, <org>/, <project>, or a directory path",
          parse: String,
          optional: true,
        },
        {
          placeholder: "directory",
          brief: "Project directory (default: current directory)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      yes: {
        ...YES_FLAG,
        brief:
          "Accept non-interactive defaults (requires --features outside a TTY)",
      },
      "dry-run": DRY_RUN_FLAG,
      features: {
        kind: "parsed",
        parse: String,
        brief:
          "Features to enable: errors,tracing,logs,replay,profiling,crons,agent-tracing,mcp-observability",
        variadic: true,
        optional: true,
      },
      team: {
        kind: "parsed",
        parse: String,
        brief: "Team slug to create the project under",
        optional: true,
      },
      app: {
        kind: "parsed",
        parse: String,
        brief:
          "App to initialize in a monorepo (required with --yes when multiple apps are detected)",
        optional: true,
      },
      tui: {
        kind: "boolean",
        brief:
          "Use the Ink-based interactive UI (default). Pass --no-tui to fall back to plain log output.",
        default: true,
      },
    },
    aliases: {
      ...DRY_RUN_ALIASES,
      ...YES_ALIASES,
      t: "team",
    },
  },
  // biome-ignore lint/correctness/useYield: init renders through WizardUI instead of command output
  async *func(
    this: SentryContext,
    flags: InitFlags,
    first?: string,
    second?: string
  ) {
    // 1. Classify positionals into target vs directory
    const { target: targetArg, directory: dirArg } = classifyArgs(
      first,
      second
    );

    // 2. Resolve directory
    const targetDir = dirArg ? path.resolve(this.cwd, dirArg) : this.cwd;

    // 3. Parse and validate features before any network or wizard work.
    const featuresList = parseFeatures(flags.features);

    // Non-TTY callers (CI/agents) must provide every interactive choice
    // needed to start setup. Fail before project lookup, org prefetch, or
    // UI creation so the error is deterministic and actionable.
    try {
      validateNonInteractiveInit(this, flags, featuresList);
    } catch (err) {
      setTag("wizard.outcome", "context_error");
      throw err;
    }

    // 4. Resolve target → org + project
    //    Validation of user-provided slugs happens inside resolveTarget.
    //    For bare slugs, if no existing project is found, the slug becomes
    //    the name for a new project (org resolved later by the wizard).
    const { org: explicitOrg, project: explicitProject } =
      await resolveTarget(targetArg);

    // Mastra requires an explicit bearer, unlike regular Sentry API requests
    // that refresh OAuth lazily. Resolve it before opening the wizard so an
    // AuthError can trigger auto-login without leaving a stale screen behind.
    await refreshToken();

    // 5. Start background org detection when org is not yet known.
    //    The prefetch runs concurrently with the preamble, the wizard startup,
    //    and all early suspend/resume rounds — by the time the wizard needs the
    //    org (inside createSentryProject), the result is already cached.
    if (!explicitOrg) {
      warmOrgDetection(targetDir);
    }

    // 6. Run the wizard.
    await runWizard({
      directory: targetDir,
      yes: flags.yes,
      dryRun: flags["dry-run"],
      features: featuresList,
      team: flags.team,
      app: flags.app,
      org: explicitOrg,
      project: explicitProject,
      // `flags.tui` defaults to `true`. `--no-tui` (auto-generated
      // by stricli's flag negation) flips it to `false` — that's the
      // signal we forward to the factory as `forceLegacyUi`.
      forceLegacyUi: flags.tui === false,
    });
  },
});
