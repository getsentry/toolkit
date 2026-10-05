/**
 * sentry trial list
 *
 * List product trials available to an organization, including
 * active trials with time remaining, expired trials, and
 * plan-level upgrade trials.
 */

import type { SentryContext } from "../../context.js";
import { getCustomerTrialInfo } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError } from "../../lib/errors.js";
import { colorTag } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type Column, writeTable } from "../../lib/formatters/table.js";
import { withProgress } from "../../lib/polling.js";
import { resolveOrg } from "../../lib/resolve-target.js";
import {
  daysRemainingFromDate,
  getDaysRemaining,
  getTrialDisplayName,
  getTrialFriendlyName,
  getTrialStatus,
  type TrialStatus,
} from "../../lib/trials.js";
import {
  type CustomerTrialInfo,
  ProductTrialSchema,
  type Writer,
} from "../../types/index.js";

type ListFlags = {
  readonly json: boolean;
  readonly fields?: string[];
};

/**
 * Enriched trial entry for display.
 * Adds derived fields (name, displayName, status, daysRemaining) to the raw API data.
 */
type TrialListEntry = {
  /** CLI-friendly name (e.g., "seer") or "plan" for plan-level trials */
  name: string;
  /** Human-readable product name (e.g., "Seer") or plan upgrade name */
  displayName: string;
  /** API category name (e.g., "seerUsers"), or "plan" for plan-level trials */
  category: string;
  /** Derived status */
  status: TrialStatus;
  /** Days remaining for active trials, null otherwise */
  daysRemaining: number | null;
  /** Raw isStarted flag from API */
  isStarted: boolean;
  /** Trial length in days, null if not set */
  lengthDays: number | null;
  /** ISO date string when trial started, null if not started */
  startDate: string | null;
  /** ISO date string when trial ends, null if not started */
  endDate: string | null;
};

/** Status display labels with color indicators */
const STATUS_LABELS: Record<TrialStatus, string> = {
  available: `${colorTag("cyan", "○")} Available`,
  active: `${colorTag("green", "●")} Active`,
  expired: `${colorTag("muted", "−")} Expired`,
};

/** Status priority for deduplication: active > available > expired */
const STATUS_PRIORITY: Record<TrialStatus, number> = {
  active: 2,
  available: 1,
  expired: 0,
};

/**
 * Deduplicate trial entries that map to the same CLI name.
 *
 * Multiple API categories can map to a single trial name (e.g., both
 * `profileDuration` and `profileDurationUI` map to "profiling"). When
 * that happens, keep the entry with the best status (active > available >
 * expired), breaking ties by latest end date.
 */
function deduplicateTrials(entries: TrialListEntry[]): TrialListEntry[] {
  const byName = new Map<string, TrialListEntry>();
  for (const entry of entries) {
    const existing = byName.get(entry.name);
    if (!existing || isBetterTrial(entry, existing)) {
      byName.set(entry.name, entry);
    }
  }
  return [...byName.values()];
}

/**
 * Compare two trial entries — returns true if `a` should replace `b`.
 * Prefers active over available over expired, then latest end date.
 */
function isBetterTrial(a: TrialListEntry, b: TrialListEntry): boolean {
  const aPriority = STATUS_PRIORITY[a.status];
  const bPriority = STATUS_PRIORITY[b.status];
  if (aPriority !== bPriority) {
    return aPriority > bPriority;
  }
  // Same status — prefer the one with a later end date
  if (a.endDate && b.endDate) {
    return a.endDate > b.endDate;
  }
  return a.endDate !== null;
}

/**
 * Build a synthetic trial entry for a plan-level trial.
 *
 * The Sentry billing API exposes plan-level trials (e.g., "Try Business")
 * separately from product trials. This creates a unified entry so both
 * appear in the same list.
 *
 * @param info - Customer trial info from the API
 * @returns A TrialListEntry for the plan trial, or null if not applicable
 */
function buildPlanTrialEntry(info: CustomerTrialInfo): TrialListEntry | null {
  if (info.isTrial) {
    // Currently on a plan trial
    const planName = info.planDetails?.name ?? "Business";
    const endDate = info.trialEnd ?? null;
    const daysRemaining = endDate ? daysRemainingFromDate(endDate) : null;
    return {
      name: "plan",
      displayName: `${planName} Plan`,
      category: "plan",
      status: "active",
      daysRemaining,
      isStarted: true,
      lengthDays: null,
      startDate: null,
      endDate,
    };
  }

  if (info.canTrial) {
    // Plan trial available but not started
    const currentPlan = info.planDetails?.name ?? "current plan";
    return {
      name: "plan",
      displayName: `${currentPlan} -> Business`,
      category: "plan",
      status: "available",
      daysRemaining: null,
      isStarted: false,
      lengthDays: null,
      startDate: null,
      endDate: null,
    };
  }

  return null;
}

/**
 * Format trial list as a human-readable table.
 */
function formatTrialListHuman(entries: TrialListEntry[]): string {
  if (entries.length === 0) {
    return "No trials found for this organization.";
  }

  const columns: Column<TrialListEntry>[] = [
    {
      header: "TRIAL",
      value: (t) =>
        // Show CLI name in parentheses so users know the argument
        // for `sentry trial start <name>`
        t.name !== t.displayName
          ? `${t.displayName} ${colorTag("muted", `(${t.name})`)}`
          : t.displayName,
    },
    { header: "STATUS", value: (t) => STATUS_LABELS[t.status] ?? t.status },
    {
      header: "DAYS LEFT",
      value: (t) => {
        if (t.status === "active" && t.daysRemaining !== null) {
          return t.daysRemaining === 0
            ? colorTag("yellow", "<1")
            : String(t.daysRemaining);
        }
        return colorTag("muted", "—");
      },
      align: "right",
    },
  ];

  const parts: string[] = [];
  const buffer: Writer = { write: (s: string) => parts.push(s) };
  writeTable(buffer, entries, columns);
  return parts.join("").trimEnd();
}

export const listCommand = buildCommand({
  docs: {
    brief: "List product trials",
    fullDescription:
      "List product trials for an organization, including available,\n" +
      "active, and expired trials.\n\n" +
      "Examples:\n" +
      "  sentry trial list\n" +
      "  sentry trial list my-org\n" +
      "  sentry trial list --json\n\n" +
      "Alias: `sentry trials` → `sentry trial list`",
  },
  output: {
    human: formatTrialListHuman,
    jsonExclude: ["displayName"],
    schema: ProductTrialSchema,
  },
  parameters: {
    positional: {
      kind: "tuple" as const,
      parameters: [
        {
          placeholder: "org",
          brief: "Organization slug (auto-detected if omitted)",
          parse: String,
          optional: true as const,
        },
      ],
    },
  },
  async *func(this: SentryContext, flags: ListFlags, org?: string) {
    const resolved = await resolveOrg({
      org,
      cwd: this.cwd,
    });

    if (!resolved) {
      throw new ContextError("Organization", "sentry trial list <org>");
    }

    const info = await withProgress(
      { message: "Fetching trials...", json: flags.json },
      () => getCustomerTrialInfo(resolved.org)
    );
    const productTrials = info.productTrials ?? [];

    const entries: TrialListEntry[] = deduplicateTrials(
      productTrials.map((t) => ({
        name: getTrialFriendlyName(t.category),
        displayName: getTrialDisplayName(t.category),
        category: t.category,
        status: getTrialStatus(t),
        daysRemaining: getDaysRemaining(t),
        isStarted: t.isStarted,
        lengthDays: t.lengthDays,
        startDate: t.startDate,
        endDate: t.endDate,
      }))
    );

    // Add plan-level trial entry (available or active) at the top
    const planEntry = buildPlanTrialEntry(info);
    if (planEntry) {
      entries.unshift(planEntry);
    }

    const hints: string[] = [];
    const hasAvailableProduct = entries.some(
      (e) => e.status === "available" && e.category !== "plan"
    );
    if (hasAvailableProduct) {
      hints.push("Tip: Use 'sentry trial start <name>' to start a trial");
    }
    if (planEntry?.status === "available") {
      hints.push(
        "Tip: Use 'sentry trial start plan' to start a Business plan trial"
      );
    }

    yield new CommandOutput(entries);
    return { hint: hints.join("\n") || undefined };
  },
});
