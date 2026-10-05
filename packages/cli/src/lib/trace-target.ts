/**
 * Shared Trace-Target Parsing & Resolution
 *
 * Provides a unified abstraction for commands that accept trace IDs
 * with optional org/project context. Trace IDs are globally unique,
 * so these formats are all supported:
 *
 * - `<trace-id>` — auto-detect org/project from DSN/config
 * - `<org>/<trace-id>` — org-scoped (for org-only APIs like trace-logs)
 * - `<org>/<project>/<trace-id>` — fully explicit
 *
 * Also handles two-arg forms:
 * - `<org>/<project> <trace-id>` — target as first arg, trace ID as second
 * - `<project> <trace-id>` — project-first bare target with org fallback
 *
 * Used by: span list, span view, trace view, trace logs.
 */

import { normalizeSlug, parseOrgProjectArg } from "./arg-parsing.js";
import { ContextError, ValidationError } from "./errors.js";
import {
  handleRecoveryResult,
  recoverHexId,
  resolveRecoveryOrg,
} from "./hex-id-recovery.js";
import { logger } from "./logger.js";
import {
  guideOrgProjectFailure,
  resolveOrg,
  resolveOrgAndProject,
  resolveOrgOnlyTarget,
  resolveOrgOptionalTarget,
  resolveProjectBoundTarget,
} from "./resolve-target.js";
import { setOrgProjectContext } from "./telemetry.js";
import { isTraceId, validateTraceId } from "./trace-id.js";

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

/**
 * Parse trace-related positional arguments into a {@link ParsedTraceTarget}.
 *
 * **Single argument (slash-separated):**
 * - `<trace-id>` → auto-detect
 * - `<org>/<trace-id>` → org-scoped
 * - `<org>/<project>/<trace-id>` → explicit
 *
 * **Two arguments (space-separated):**
 * - `<org>/<project> <trace-id>` → explicit
 * - `<target> <trace-id>` → project-first bare target with org fallback
 *
 * Extra positional arguments beyond the first two are ignored with a
 * warning, matching the established pattern across CLI commands.
 *
 * @param args - Positional arguments from CLI
 * @param usageHint - Usage example for error messages
 * @returns Parsed trace target with type discrimination
 * @throws {ContextError} If no arguments are provided
 * @throws {ValidationError} If the trace ID format is invalid
 */
export function parseTraceTarget(
  args: string[],
  usageHint: string
): ParsedTraceTarget {
  if (args.length === 0) {
    throw new ContextError("Trace ID", usageHint, []);
  }

  const first = args[0];
  if (first === undefined) {
    throw new ContextError("Trace ID", usageHint, []);
  }

  // Warn about extra positional args that will be ignored
  if (args.length > 2) {
    log.warn(
      `Extra arguments ignored: ${args.slice(2).join(" ")}. Expected: ${usageHint}`
    );
  }

  if (args.length === 1) {
    return parseSlashSeparatedTraceTarget(first, usageHint);
  }

  // Two+ args: first is target context, second is trace ID
  const second = args[1];
  if (second === undefined) {
    return parseSlashSeparatedTraceTarget(first, usageHint);
  }

  const traceId = validateTraceId(second);
  return targetArgToTraceTarget(first, traceId);
}

/**
 * Parse a single slash-separated argument into a trace target.
 *
 * - No slashes → auto-detect (bare trace ID)
 * - One slash → `<org>/<trace-id>` (org-scoped)
 * - Two+ slashes → split on last `/` → `<org>/<project>/<trace-id>` (explicit)
 *
 * @internal Exported for testing
 */
export function parseSlashSeparatedTraceTarget(
  input: string,
  usageHint: string
): ParsedTraceTarget {
  const lastSlash = input.lastIndexOf("/");

  if (lastSlash === -1) {
    // No slashes — bare trace ID
    return { type: "auto-detect", traceId: validateTraceId(input) };
  }

  const prefix = input.slice(0, lastSlash);
  const rawTraceId = input.slice(lastSlash + 1);

  if (!rawTraceId) {
    throw new ContextError("Trace ID", usageHint, []);
  }

  const traceId = validateTraceId(rawTraceId);

  if (!prefix) {
    // "/<trace-id>" — leading slash, treat as auto-detect
    return { type: "auto-detect", traceId };
  }

  const innerSlash = prefix.indexOf("/");

  if (innerSlash === -1) {
    // "org/<trace-id>" — org-scoped
    const ns = normalizeSlug(prefix);
    return {
      type: "org-scoped",
      traceId,
      org: ns.slug,
      ...(ns.normalized && { normalized: true }),
    };
  }

  // "org/project/<trace-id>" — explicit
  const rawOrg = prefix.slice(0, innerSlash);
  const rawProject = prefix.slice(innerSlash + 1);

  if (!(rawOrg && rawProject)) {
    throw new ContextError("Trace ID", usageHint, []);
  }

  const no = normalizeSlug(rawOrg);
  const np = normalizeSlug(rawProject);
  const normalized = no.normalized || np.normalized;

  return {
    type: "explicit",
    traceId,
    org: no.slug,
    project: np.slug,
    ...(normalized && { normalized: true }),
  };
}

/**
 * Convert a target argument + validated trace ID into a trace target.
 * Delegates org/project parsing to {@link parseOrgProjectArg}.
 *
 * Note: `parseOrgProjectArg` already emits slug normalization warnings
 * internally, so `normalized` is NOT propagated here to avoid double
 * warnings when callers also check via {@link warnIfNormalized}.
 *
 * @internal Exported for testing
 */
export function targetArgToTraceTarget(
  targetArg: string,
  traceId: string
): ParsedTraceTarget {
  const parsed = parseOrgProjectArg(targetArg);

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
 * Extract the raw trace ID slot from a positional-arg invocation **without
 * validating** it. Returns `{ rawTraceId, targetArg? }` where:
 *
 * - Single arg → the part after the last `/` is the trace ID candidate,
 *   and anything before the last `/` is the target (org/project[/]).
 * - Two+ args → the second arg is the raw trace ID, the first is the target.
 *
 * Used by {@link parseTraceTargetWithRecovery} to peek at the raw input
 * before `parseTraceTarget` runs its strict validation. Returns null when
 * there isn't a usable trace ID slot (e.g., zero args).
 */
export function extractRawTraceId(
  args: string[]
): { rawTraceId: string; targetArg?: string } | null {
  if (args.length === 0) {
    return null;
  }
  if (args.length === 1) {
    const first = args[0];
    if (!first) {
      return null;
    }
    const lastSlash = first.lastIndexOf("/");
    if (lastSlash === -1) {
      return { rawTraceId: first };
    }
    const rawTraceId = first.slice(lastSlash + 1);
    const prefix = first.slice(0, lastSlash);
    return rawTraceId
      ? { rawTraceId, targetArg: prefix || undefined }
      : { rawTraceId: "" };
  }
  const second = args[1];
  const first = args[0];
  if (second === undefined) {
    return null;
  }
  return { rawTraceId: second, targetArg: first };
}

/**
 * Parse trace-target args, falling back to {@link recoverHexId} on an
 * invalid trace ID. Returns a {@link ParsedTraceTarget} with a validated
 * or recovered trace ID, or throws the original {@link ValidationError}
 * when recovery can't proceed.
 *
 * The recovery path runs the cheap classifications (sentinel, slug, etc.)
 * locally regardless of context. Fuzzy prefix lookup additionally requires
 * an org+project, which we only extract from an explicit target — we do
 * NOT attempt DSN/config auto-detection during recovery (it's expensive
 * and the adapter returns empty without a project anyway).
 */
export async function parseTraceTargetWithRecovery(
  args: string[],
  usageHint: string
): Promise<ParsedTraceTarget> {
  try {
    return parseTraceTarget(args, usageHint);
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      throw err;
    }
    const raw = extractRawTraceId(args);
    if (!raw?.rawTraceId) {
      throw err;
    }
    const ctx = await recoveryContextFromTargetArg(raw.targetArg);
    const result = await recoverHexId(raw.rawTraceId, "trace", ctx);
    const recoveredTraceId = handleRecoveryResult(result, err, {
      entityType: "trace",
      canonicalCommand: `sentry trace view ${ctx.org || "<org>"}/${ctx.project ?? "<project>"}/<id>`,
      logTag: "trace-target",
    });
    const newArgs = substituteTraceId(args, recoveredTraceId);
    return parseTraceTarget(newArgs, usageHint);
  }
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
  targetArg: string | undefined
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
 * Rebuild the positional args with the recovered trace ID in the correct
 * slot. Mirrors the logic in {@link extractRawTraceId}.
 */
function substituteTraceId(args: string[], recoveredTraceId: string): string[] {
  if (args.length === 1) {
    const first = args[0];
    if (!first) {
      return [recoveredTraceId];
    }
    const lastSlash = first.lastIndexOf("/");
    if (lastSlash === -1) {
      return [recoveredTraceId];
    }
    const prefix = first.slice(0, lastSlash);
    return [`${prefix}/${recoveredTraceId}`];
  }
  return [args[0] ?? "", recoveredTraceId, ...args.slice(2)];
}

/**
 * Emit a slug normalization warning if applicable.
 * Shared by all trace commands to avoid duplicating the check.
 */
export function warnIfNormalized(parsed: ParsedTraceTarget, tag: string): void {
  if ("normalized" in parsed && parsed.normalized) {
    const taggedLog = logger.withTag(tag);
    taggedLog.warn(
      "Normalized slug (Sentry slugs use lowercase with dashes, not spaces)"
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
  usageHint: string
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
      usageHint
    );
    return { traceId: parsed.traceId, ...resolved };
  }
  return resolveTraceOrgProject(parsed, cwd, usageHint);
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
  usageHint: string
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
      return resolveProjectSearchTarget(parsed, cwd, usageHint);

    case "org-scoped":
      throw new ContextError("Specific project", usageHint, [
        `Use: ${usageHint.replace(USAGE_TARGET_RE, `${parsed.org}/<project>/${parsed.traceId}`)}`,
        `List projects: sentry project list ${parsed.org}/`,
      ]);

    case "auto-detect": {
      // resolveOrgAndProject already sets telemetry context. On a failed
      // auto-detect, guideOrgProjectFailure offers an interactive picker (TTY)
      // or an actionable error listing the user's accessible orgs.
      const resolved =
        (await resolveOrgAndProject({ cwd, usageHint })) ??
        (await guideOrgProjectFailure({ usageHint }));
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
  usageHint: string
): Promise<ResolvedTraceOrgProject> {
  const target = await resolveProjectBoundTarget(
    parsed,
    cwd,
    commandNameFromUsageHint(usageHint),
    { usageHint }
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
  usageHint: string
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
        usageHint
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
 * Result from dual-mode argument disambiguation.
 *
 * Used by commands that support both project-scoped listing (no trace ID)
 * and trace-scoped listing (trace ID provided), like `span list` and
 * `log list`.
 *
 * Discriminated on `mode`:
 * - `"project"` — no trace ID detected; `target` is the optional org/project arg
 * - `"trace"` — a 32-char hex trace ID was found; `parsed` contains the full target
 */
export type ParsedDualModeArgs =
  | { mode: "project"; target?: string }
  | { mode: "trace"; parsed: ParsedTraceTarget };

/**
 * Disambiguate positional arguments for dual-mode list commands.
 *
 * Detects trace mode by checking whether any argument segment looks like
 * a 32-char hex trace ID via {@link isTraceId}:
 *
 * - **No args**: project mode (auto-detect org/project)
 * - **Two+ args**: checks the last positional. If it's a trace ID → trace
 *   mode (space-separated form like `<project> <trace-id>`).
 * - **Single arg**: checks the tail segment (last part after `/`). If it
 *   looks like a trace ID → trace mode. Otherwise → project target.
 *
 * When trace mode is detected, delegates to {@link parseTraceTarget} for
 * full parsing and validation.
 *
 * @param args - Positional arguments from CLI
 * @param traceUsageHint - Usage hint for trace-mode error messages
 * @returns Parsed args with mode discrimination
 */
export function parseDualModeArgs(
  args: string[],
  traceUsageHint: string
): ParsedDualModeArgs {
  if (args.length === 0) {
    return { mode: "project" };
  }

  const first = args[0];
  if (first === undefined) {
    return { mode: "project" };
  }

  // Two+ args: check if the last arg is a trace ID (space-separated form)
  if (args.length >= 2) {
    const last = args.at(-1);
    if (last && isTraceId(last)) {
      return {
        mode: "trace",
        parsed: parseTraceTarget(args, traceUsageHint),
      };
    }
  }

  // Single arg: check the tail segment (last part after "/", or entire arg)
  const lastSlash = first.lastIndexOf("/");
  const tail = lastSlash === -1 ? first : first.slice(lastSlash + 1);
  if (isTraceId(tail)) {
    return {
      mode: "trace",
      parsed: parseTraceTarget(args, traceUsageHint),
    };
  }

  // Not a trace ID → treat as project target
  return { mode: "project", target: first };
}
