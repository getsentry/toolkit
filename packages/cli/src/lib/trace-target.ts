/**
 * Shared Trace-Target Parsing & Resolution
 *
 * Trace commands take their trace ID like every ID-taking command (see
 * `id-arguments.ts`): `<trace-id>`, `<org>/<trace-id>`,
 * `<org>/<project>/<trace-id>`, `<target> <trace-id>`, or a trace URL.
 * This module turns that into a {@link ParsedTraceTarget} and resolves it
 * to the org (and project) the command's API needs.
 *
 * Used by: span list, span view, trace view, trace logs, log list.
 */

import {
  type ParsedOrgProject,
  parseOrgProjectArg,
  parseOrgProjectInput,
} from "./arg-parsing.js";
import { ContextError, ValidationError } from "./errors.js";
import {
  handleRecoveryResult,
  recoverHexId,
  resolveRecoveryOrg,
} from "./hex-id-recovery.js";
import {
  ID_KINDS,
  type IdArguments,
  parseIdArgument,
  parseIdArguments,
} from "./id-arguments.js";
import { logger } from "./logger.js";
import {
  guideOrgProjectFailure,
  resolveOrg,
  resolveOrgAndProject,
  resolveOrgOnlyTarget,
  resolveOrgOptionalTarget,
  resolveProjectBoundTarget,
} from "./resolve-target.js";
import { applySentryUrlContext } from "./sentry-url-parser.js";
import { setOrgProjectContext } from "./telemetry.js";

const log = logger.withTag("trace-target");

/** Match `[<prefix>]<trail>` in usageHint — captures bracket content + trailing placeholder */
const USAGE_TARGET_RE = /\[.*\]<[^>]+>/;
const SENTRY_COMMAND_PREFIX_RE = /^sentry\s+/;
const USAGE_ARGUMENT_START_RE = /\s+(?:\[|<)/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed result from trace-related positional arguments.
 * Discriminated union based on the `type` field.
 *
 * Unlike `ParsedOrgProject`, the `traceId` is always present
 * because it's the mandatory identifier for all trace commands.
 */
export type ParsedTraceTarget =
  | {
      type: "explicit";
      traceId: string;
      org: string;
      project: string;
      /** True if any slug was normalized (spaces → dashes with lowercasing) */
      normalized?: boolean;
    }
  | {
      type: "org-scoped";
      traceId: string;
      org: string;
      /** True if org slug was normalized */
      normalized?: boolean;
    }
  | {
      type: "project-search";
      traceId: string;
      projectSlug: string;
      /** Optional organization scope for display-name project searches. */
      org?: string;
      /** Project display name before slug normalization. */
      originalSlug?: string;
      /** True if slug was normalized */
      normalized?: boolean;
    }
  | {
      type: "auto-detect";
      traceId: string;
    };

/**
 * A {@link ParsedTraceTarget} parsed without side effects, plus what the
 * caller applies when it runs: the server of a pasted Sentry URL (for
 * `applySentryUrlContext`) and warnings to log.
 */
export type TraceTargetInput = {
  readonly parsed: ParsedTraceTarget;
  readonly baseUrl?: string;
  readonly warnings: readonly string[];
};

/** Apply what parsing a trace target deferred, and return the target. */
export function applyTraceTargetInput(
  input: TraceTargetInput,
): ParsedTraceTarget {
  if (input.baseUrl) {
    applySentryUrlContext(input.baseUrl);
  }
  for (const warning of input.warnings) {
    log.warn(warning);
  }
  return input.parsed;
}

/** Resolved trace target with both org and project. */
export type ResolvedTraceOrgProject = {
  traceId: string;
  org: string;
  project: string;
};

/** Resolved trace target with org only. */
export type ResolvedTraceOrg = {
  traceId: string;
  org: string;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** How a trace command takes its trace ID. */
export type TraceArgumentsOptions = {
  /**
   * Whether the command needs a project (`span list`, `span view`): then
   * `<x>/<trace-id>` names project `<x>` instead of org `<x>`.
   */
  readonly needsProject?: boolean;
};

/**
 * Parse trace-related positional arguments into a {@link ParsedTraceTarget},
 * without side effects: the server of a pasted Sentry URL and the warnings
 * are returned for the caller to apply ({@link applyTraceTargetInput}).
 *
 * Takes the forms every ID-taking command does (see `id-arguments.ts`):
 * `<trace-id>`, `<org>/<trace-id>`, `<org>/<project>/<trace-id>`,
 * `<target> <trace-id>`, `<trace-id> <target>`, or a trace URL. Extra
 * arguments are ignored with a warning.
 *
 * @throws {ContextError} When the trace ID is missing
 * @throws {ValidationError} When the trace ID or the target is invalid
 */
export function parseTraceTargetInput(
  args: readonly string[],
  usageHint: string,
  options: TraceArgumentsOptions = {},
): TraceTargetInput {
  const { id, ...rest } = parseIdArgument(args, ID_KINDS.trace, {
    usageHint,
    ...options,
  });
  return traceTargetInput({ ...rest, ids: [id] });
}

/**
 * Turn {@link IdArguments} with one trace ID into a trace target. The target
 * parses like any org/project target.
 */
function traceTargetInput({
  target,
  ids,
  baseUrl,
  warnings,
}: IdArguments): TraceTargetInput {
  const traceId = ids[0] ?? "";
  const input = parseOrgProjectInput(target);
  return {
    parsed: orgProjectToTraceTarget(input.parsed, traceId),
    baseUrl: baseUrl ?? input.baseUrl,
    warnings,
  };
}

function orgProjectToTraceTarget(
  parsed: ParsedOrgProject,
  traceId: string,
): ParsedTraceTarget {
  switch (parsed.type) {
    case "explicit":
      return {
        type: "explicit",
        traceId,
        org: parsed.org,
        project: parsed.project,
      };

    case "org-all":
      // "org/" → org-scoped (valid for trace commands, not "all projects")
      return {
        type: "org-scoped",
        traceId,
        org: parsed.org,
      };

    case "project-search":
      return {
        type: "project-search",
        traceId,
        projectSlug: parsed.projectSlug,
        ...(parsed.org !== undefined && { org: parsed.org }),
        ...(parsed.originalSlug !== undefined && {
          originalSlug: parsed.originalSlug,
        }),
      };

    case "auto-detect":
      return { type: "auto-detect", traceId };

    default: {
      const _exhaustive: never = parsed;
      throw new ValidationError(`Unexpected target: ${_exhaustive}`);
    }
  }
}

/**
 * Trace arguments parsed like {@link parseTraceTargetInput}, but with the
 * trace ID as typed: {@link resolveTraceArguments} validates it, or
 * recovers a malformed one, when the command runs.
 */
export type TraceArgumentsInput = TraceTargetInput & {
  /** The target argument as typed, for the recovery lookup */
  readonly targetArg?: string;
};

/**
 * Parse trace arguments without side effects and without validating the
 * trace ID, so a malformed one can be recovered once the command runs.
 *
 * @throws {ContextError} When the trace ID is missing
 * @throws {ValidationError} When the target is invalid
 */
export function parseTraceArgumentsInput(
  args: readonly string[],
  usageHint: string,
  options: TraceArgumentsOptions = {},
): TraceArgumentsInput {
  const { id, ...rest } = parseIdArgument(args, ID_KINDS.trace, {
    usageHint,
    ...options,
    validate: false,
  });
  return {
    ...traceTargetInput({ ...rest, ids: [id] }),
    targetArg: rest.target,
  };
}

/**
 * Apply what {@link parseTraceArgumentsInput} deferred and validate the
 * trace ID, falling back to {@link recoverHexId} on an invalid one.
 * Returns a {@link ParsedTraceTarget} with a validated or recovered trace
 * ID, or throws the original {@link ValidationError} when recovery can't
 * proceed.
 *
 * The recovery path runs the cheap classifications (sentinel, slug, etc.)
 * locally regardless of context. Fuzzy prefix lookup additionally requires
 * an org+project, which we only extract from an explicit target — we do
 * NOT attempt DSN/config auto-detection during recovery (it's expensive
 * and the adapter returns empty without a project anyway).
 */
export async function resolveTraceArguments(
  input: TraceArgumentsInput,
): Promise<ParsedTraceTarget> {
  const parsed = applyTraceTargetInput(input);
  try {
    return { ...parsed, traceId: ID_KINDS.trace.validate(parsed.traceId) };
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      throw err;
    }
    const traceId = await recoverTraceId(parsed.traceId, input.targetArg, err);
    return { ...parsed, traceId };
  }
}

/**
 * Recover a malformed trace ID with {@link recoverHexId}, in the context of
 * the target argument, if any.
 *
 * @throws The original `failure` when recovery finds nothing
 */
async function recoverTraceId(
  rawTraceId: string,
  targetArg: string | undefined,
  failure: ValidationError,
): Promise<string> {
  const ctx = await recoveryContextFromTargetArg(targetArg);
  const result = await recoverHexId(rawTraceId, "trace", ctx);
  return handleRecoveryResult(result, failure, {
    entityType: "trace",
    canonicalCommand: `sentry trace view ${ctx.org || "<org>"}/${ctx.project ?? "<project>"}/<id>`,
    logTag: "trace-target",
  });
}

/**
 * Best-effort recovery context derived from a raw target arg.
 *
 * `parseOrgProjectArg` throws on malformed slugs (e.g. `--h/nothex`
 * produces a slug-validation error). Those errors are unrelated to the
 * trace-ID problem we're trying to recover from; catching them here
 * avoids masking the original trace-ID `ValidationError` with a
 * confusing slug error.
 */
async function recoveryContextFromTargetArg(
  targetArg: string | undefined,
): Promise<{ org: string; project?: string }> {
  if (!targetArg) {
    return { org: "", project: undefined };
  }
  let parsedTarget: ReturnType<typeof parseOrgProjectArg>;
  try {
    parsedTarget = parseOrgProjectArg(targetArg);
  } catch (error) {
    log.debug("Failed to parse target arg for recovery context", error);
    return { org: "", project: undefined };
  }
  return (
    (await resolveRecoveryOrg(parsedTarget)) ?? {
      org: "",
      project: undefined,
    }
  );
}

/**
 * Emit a slug normalization warning if applicable.
 * Shared by all trace commands to avoid duplicating the check.
 */
export function warnIfNormalized(parsed: ParsedTraceTarget, tag: string): void {
  if ("normalized" in parsed && parsed.normalized) {
    const taggedLog = logger.withTag(tag);
    taggedLog.warn(
      "Normalized slug (Sentry slugs use lowercase with dashes, not spaces)",
    );
  }
}

// ---------------------------------------------------------------------------
// Resolution — org + project
// ---------------------------------------------------------------------------

function commandNameFromUsageHint(usageHint: string): string {
  const withoutPrefix = usageHint.replace(SENTRY_COMMAND_PREFIX_RE, "");
  const targetIndex = withoutPrefix.search(USAGE_ARGUMENT_START_RE);
  return targetIndex === -1
    ? withoutPrefix
    : withoutPrefix.slice(0, targetIndex);
}

/**
 * Resolve a parsed trace target to org + optional project.
 *
 * For commands like `trace view` where the underlying API works org-wide
 * and a project slug is not required. Returns `project: undefined` when
 * the target is org-scoped (i.e. `<org>/<trace-id>`).
 *
 * @throws {ContextError} If auto-detection fails
 */
export async function resolveTraceOrgOptionalProject(
  parsed: ParsedTraceTarget,
  cwd: string,
  usageHint: string,
): Promise<ResolvedTraceOrgProject | ResolvedTraceOrg> {
  if (parsed.type === "org-scoped") {
    setOrgProjectContext([parsed.org], []);
    return { traceId: parsed.traceId, org: parsed.org };
  }
  if (parsed.type === "project-search") {
    const resolved = await resolveOrgOptionalTarget(
      parsed,
      cwd,
      commandNameFromUsageHint(usageHint),
      usageHint,
    );
    return { traceId: parsed.traceId, ...resolved };
  }
  return await resolveTraceOrgProject(parsed, cwd, usageHint);
}

/**
 * Resolve a parsed trace target to org + project.
 *
 * For commands like `span list` and `span view` that require both
 * org and project for API calls.
 *
 * @throws {ContextError} If org-scoped without project
 * @throws {ContextError} If auto-detection fails
 */
export async function resolveTraceOrgProject(
  parsed: ParsedTraceTarget,
  cwd: string,
  usageHint: string,
): Promise<ResolvedTraceOrgProject> {
  switch (parsed.type) {
    case "explicit":
      setOrgProjectContext([parsed.org], [parsed.project]);
      return {
        traceId: parsed.traceId,
        org: parsed.org,
        project: parsed.project,
      };

    case "project-search":
      // resolveProjectBoundTarget (called inside) sets telemetry context.
      return await resolveProjectSearchTarget(parsed, cwd, usageHint);

    case "org-scoped":
      throw new ContextError("Specific project", usageHint, [
        `Use: ${usageHint.replace(USAGE_TARGET_RE, `${parsed.org}/<project>/${parsed.traceId}`)}`,
        `List projects: sentry project list ${parsed.org}/`,
      ]);

    case "auto-detect": {
      // resolveOrgAndProject already sets telemetry context. On a failed
      // auto-detect, guideOrgProjectFailure offers an interactive picker (TTY)
      // or an actionable error listing explicit project candidates.
      const resolved =
        (await resolveOrgAndProject({ cwd, usageHint })) ??
        (await guideOrgProjectFailure({ cwd, usageHint }));
      return {
        traceId: parsed.traceId,
        org: resolved.org,
        project: resolved.project,
      };
    }

    default: {
      const _exhaustive: never = parsed;
      throw new ValidationError(`Unexpected target type: ${_exhaustive}`);
    }
  }
}

/** Resolve a project-search target by searching across orgs. */
async function resolveProjectSearchTarget(
  parsed: Extract<ParsedTraceTarget, { type: "project-search" }>,
  cwd: string,
  usageHint: string,
): Promise<ResolvedTraceOrgProject> {
  const target = await resolveProjectBoundTarget(
    parsed,
    cwd,
    commandNameFromUsageHint(usageHint),
    { usageHint },
  );
  return {
    traceId: parsed.traceId,
    org: target.org,
    project: target.project,
  };
}

// ---------------------------------------------------------------------------
// Resolution — org only
// ---------------------------------------------------------------------------

/**
 * Resolve a parsed trace target to org only.
 *
 * For commands like `trace logs` where the API is org-scoped.
 * When both org and project are provided, only org is used.
 *
 * @throws {ContextError} If auto-detection fails
 */
export async function resolveTraceOrg(
  parsed: ParsedTraceTarget,
  cwd: string,
  usageHint: string,
): Promise<ResolvedTraceOrg> {
  switch (parsed.type) {
    case "explicit":
      setOrgProjectContext([parsed.org], []);
      return { traceId: parsed.traceId, org: parsed.org };

    case "org-scoped":
      setOrgProjectContext([parsed.org], []);
      return { traceId: parsed.traceId, org: parsed.org };

    case "project-search": {
      const org = await resolveOrgOnlyTarget(
        parsed,
        cwd,
        commandNameFromUsageHint(usageHint),
        usageHint,
      );
      return { traceId: parsed.traceId, org };
    }

    case "auto-detect": {
      // resolveOrg already sets telemetry context
      const resolved = await resolveOrg({ cwd });
      if (!resolved) {
        throw new ContextError("Organization", usageHint);
      }
      return { traceId: parsed.traceId, org: resolved.org };
    }

    default: {
      const _exhaustive: never = parsed;
      throw new ValidationError(`Unexpected target type: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Dual-mode argument disambiguation (project vs trace)
// ---------------------------------------------------------------------------

/**
 * Positional arguments of a dual-mode list command, parsed without side
 * effects. Discriminated on `mode`:
 * - `"project"` — no trace ID; `target` is the optional org/project argument
 * - `"trace"` — a trace ID; `trace` is the target to apply and resolve
 */
export type DualModeInput =
  | { mode: "project"; target?: string }
  | { mode: "trace"; trace: TraceTargetInput };

/**
 * Disambiguate positional arguments for dual-mode list commands (`span list`,
 * `log list`), without side effects.
 *
 * Trace mode when the arguments name a trace ID in any of the forms
 * {@link parseTraceTargetInput} takes; otherwise project mode, with the
 * first argument as the target.
 */
export function parseDualModeInput(
  args: readonly string[],
  traceUsageHint: string,
  options: TraceArgumentsOptions = {},
): DualModeInput {
  const input = parseIdArguments(args, ID_KINDS.trace, {
    ...options,
    usageHint: traceUsageHint,
    optional: true,
  });
  if (input.ids.length > 0) {
    return { mode: "trace", trace: traceTargetInput(input) };
  }
  return input.target === undefined
    ? { mode: "project" }
    : { mode: "project", target: input.target };
}
