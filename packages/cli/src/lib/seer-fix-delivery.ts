/** Deliver completed Seer changes to a local checkout or repository pull requests. */
import { setTimeout as sleep } from "node:timers/promises";
import type { ExplorerSession, FixResult } from "../types/seer-fix.js";
import { apiRequestToRegion, getSeerExplorerState } from "./api-client.js";
import { redactCredentialText } from "./credential-redaction.js";
import { CliError } from "./errors.js";
import { resolveOrgRegion } from "./region.js";
import { extractFixPatches } from "./seer-fix.js";
import { applySeerPatches } from "./seer-patch.js";

/** Preserve the generated fix when delivery succeeds only partially or fails. */
export type FixDeliveryResult = FixResult & {
  /** Repository-relative paths successfully changed in the local checkout. */
  applied_files?: string[];
  /** Delivery failures, with recognizable credentials removed. */
  delivery_errors?: string[];
};

/** Explicit delivery choices for a completed fix. Neither action is implicit. */
export type FixDeliveryOptions = {
  /** Organization that owns the pinned Seer conversation. */
  org: string;
  /** Generated fix to deliver; must be completed and have no pending approval. */
  result: FixResult;
  /** Directory inside the target checkout, used only for local application. */
  cwd: string;
  /** Apply the complete patch batch to the local working tree. */
  apply: boolean;
  /** Create or await a PR for each affected repository. */
  pr: boolean;
  /** Total operation budget in milliseconds; defaults to six minutes. */
  timeoutMs?: number;
  /** Interval between safe PR state reads; defaults to two seconds. */
  pollIntervalMs?: number;
  /** Caller cancellation signal, combined with the total operation budget. */
  signal?: AbortSignal;
};

type RepoPrState = NonNullable<ExplorerSession["repo_pr_states"]>[string];

/** Bound even region resolution or clients that have not yet observed cancellation. */
async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}

/** Compare complete patch metadata without depending on JSON object key order. */
function patchSnapshot(patches: FixResult["patches"]): string {
  const files = patches.map(({ repo_name, diff, patch }) => ({
    repo_name,
    diff,
    patch,
  }));
  files.sort(
    (left, right) =>
      left.repo_name.localeCompare(right.repo_name) ||
      left.patch.path.localeCompare(right.patch.path),
  );
  return JSON.stringify(files, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      );
    }
    return value;
  });
}

/** Raw patches are per-edit increments; repeated files require an authoritative merged diff. */
function requireUnambiguousPatches(session: ExplorerSession): void {
  const blocks = session.blocks ?? [];
  if (
    blocks.some(
      (block) =>
        block.merged_file_patches !== undefined &&
        block.merged_file_patches !== null,
    )
  ) {
    return;
  }
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const patch of block.file_patches ?? []) {
      const key = `${patch.repo_name}:${patch.patch.path}`;
      if (seen.has(key)) {
        throw new CliError(
          "Seer returned repeated incremental edits to one file without merged diffs. Inspect the full changes in Sentry and wait for merged patches before requesting delivery.",
        );
      }
      seen.add(key);
    }
  }
}

/** Read repository completion independently of the conversation's overall status. */
function isPrComplete(state: RepoPrState | undefined, repo: string): boolean {
  if (!state) {
    return false;
  }
  if (state.repo_name !== repo) {
    throw new CliError(
      `PR state does not match repository ${repo}; inspect the run in Sentry.`,
    );
  }
  if (state.pr_creation_status === "error") {
    throw new CliError(
      `PR creation for ${repo} failed: ${state.pr_creation_error ?? "Inspect the repository state in Sentry."}`,
    );
  }
  if (state.pr_creation_status === "completed") {
    if (!state.pr_url) {
      throw new CliError(
        `PR creation for ${repo} completed without a PR URL; inspect the run in Sentry.`,
      );
    }
    return true;
  }
  if (state.pr_creation_status === "creating") {
    return false;
  }
  if (
    state.pr_creation_status !== null &&
    state.pr_creation_status !== undefined
  ) {
    throw new CliError(
      `Unknown PR creation state for ${repo}; inspect the run in Sentry before retrying.`,
    );
  }
  return Boolean(state.pr_url);
}

/**
 * Apply changes and/or create repository PRs only after a completed approved fix.
 * Each PR request is submitted once with retries disabled. Fresh state reads avoid
 * duplicating existing or in-progress PRs. Errors retain patches and prior delivery.
 * @param options - Pinned fix result and explicitly requested delivery actions.
 * @returns Original fix plus applied files, PR URLs, and any delivery failure.
 */
export async function deliverSeerFix(
  options: FixDeliveryOptions,
): Promise<FixDeliveryResult> {
  const delivered: FixDeliveryResult = {
    ...options.result,
    pr_urls: [...options.result.pr_urls],
  };
  if (!options.apply && !options.pr) {
    return delivered;
  }
  const timeoutMs = Math.ceil(options.timeoutMs ?? 360_000);
  const validBudget =
    Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 0xffffffff;
  const timeoutSignal = AbortSignal.timeout(validBudget ? timeoutMs : 1);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const deadline = Date.now() + timeoutMs;
  const assertActive = (): void => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) {
      throw new CliError(
        "Seer fix delivery timed out. Inspect PR state in Sentry before retrying.",
      );
    }
  };
  try {
    if (!validBudget) {
      throw new CliError(
        "Delivery timeout must be a positive finite number of milliseconds.",
      );
    }
    if (
      options.result.status !== "COMPLETED" ||
      options.result.pending_user_input !== null ||
      options.result.patches.length === 0
    ) {
      throw new CliError(
        "Delivery requires a completed Seer fix with code changes and no pending user approval.",
      );
    }
    const readState = async (): Promise<ExplorerSession> => {
      assertActive();
      const session = await withAbort(
        getSeerExplorerState(options.org, options.result.run_id, { signal }),
        signal,
      );
      assertActive();
      if (!session) {
        throw new CliError(
          "Cannot find the pinned Seer conversation; inspect the run in Sentry before retrying delivery.",
        );
      }
      delivered.pr_urls = [
        ...new Set([
          ...delivered.pr_urls,
          ...Object.values(session.repo_pr_states ?? {}).flatMap((state) =>
            state.pr_url ? [state.pr_url] : [],
          ),
        ]),
      ];
      if (session.pending_user_input) {
        delivered.pending_user_input = session.pending_user_input;
        throw new CliError(
          "Seer is waiting for user input; resume the conversation before requesting delivery.",
        );
      }
      return session;
    };
    const expectedPatches = patchSnapshot(options.result.patches);
    const assertSnapshot = (
      session: ExplorerSession,
      allowProcessing = false,
    ): void => {
      requireUnambiguousPatches(session);
      if (
        session.status !== "COMPLETED" &&
        !(allowProcessing && session.status === "PROCESSING")
      ) {
        throw new CliError(
          "The pinned Seer conversation is no longer completed; resume it before requesting delivery.",
        );
      }
      if (patchSnapshot(extractFixPatches(session)) !== expectedPatches) {
        throw new CliError(
          "Seer code changes changed since this result was generated; inspect the current diffs and request delivery again.",
        );
      }
    };
    let current = await readState();
    assertSnapshot(current);
    assertActive();
    if (options.apply) {
      const applied = await applySeerPatches(
        options.result.patches,
        options.cwd,
        { signal, deadline },
      );
      delivered.applied_files = applied.applied;
      assertActive();
    }
    if (options.pr) {
      const repositories = [
        ...new Set(options.result.patches.map((patch) => patch.repo_name)),
      ];
      const pending = new Set<string>();
      for (const [index, repo] of repositories.entries()) {
        if (index > 0 || options.apply) {
          current = await readState();
          assertSnapshot(current, pending.size > 0);
        }
        const state = current.repo_pr_states?.[repo];
        if (isPrComplete(state, repo)) {
          continue;
        }
        pending.add(repo);
        if (state?.pr_creation_status === "creating") {
          continue;
        }
        const region = await withAbort(resolveOrgRegion(options.org), signal);
        assertActive();
        try {
          await withAbort(
            apiRequestToRegion(
              region,
              `/organizations/${encodeURIComponent(options.org)}/seer/explorer-update/${encodeURIComponent(String(options.result.run_id))}/`,
              {
                method: "POST",
                retry: false,
                signal,
                body: { payload: { type: "create_pr", repo_name: repo } },
              },
            ),
            signal,
          );
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : "Request failed.";
          throw new CliError(
            `PR creation request for ${repo} failed and was not repeated: ${reason} Inspect PR state in Sentry because the outcome may be uncertain.`,
          );
        }
      }
      while (pending.size > 0) {
        const session = await readState();
        for (const repo of pending) {
          if (isPrComplete(session.repo_pr_states?.[repo], repo)) {
            pending.delete(repo);
          }
        }
        if (pending.size > 0) {
          await sleep(
            Math.max(
              1,
              Math.min(options.pollIntervalMs ?? 2000, deadline - Date.now()),
            ),
            undefined,
            { signal },
          );
        }
      }
    }
    return delivered;
  } catch (error) {
    const message = options.signal?.aborted
      ? "Seer fix delivery was cancelled. Inspect PR state in Sentry before retrying."
      : timeoutSignal.aborted
        ? "Seer fix delivery timed out. Inspect PR state in Sentry before retrying."
        : error instanceof Error
          ? error.message
          : "Seer fix delivery failed.";
    const safeMessage = redactCredentialText(message);
    return {
      ...delivered,
      status: "ERROR",
      error: safeMessage,
      delivery_errors: [...(delivered.delivery_errors ?? []), safeMessage],
      next_action: `Inspect the generated diffs and PR state in Sentry, then resume the issue fix with --run-id ${options.result.run_id}.`,
    };
  }
}
