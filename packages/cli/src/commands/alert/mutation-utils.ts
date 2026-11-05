/** Native workflow request construction shared by alert create/edit. */
import { numberParser } from "../../lib/command.js";
import {
  choiceListParser,
  choiceParser,
  parseEnvironment,
  parseOwner,
  parseProjectSlug,
  parseText,
} from "../../lib/completion-target.js";
import { ValidationError } from "../../lib/errors.js";
import type {
  Alert,
  AlertCreateBody,
  AlertUpdateBody,
} from "../../lib/api/alerts.js";
import { resolveProjectAlertMonitorId } from "../../lib/api/alerts.js";

const TRIGGERS: Readonly<Record<string, string>> = {
  "first-seen": "first_seen_event",
  regression: "regression_event",
  reappeared: "reappeared_event",
  resolved: "issue_resolved_trigger",
  "new-high-priority": "new_high_priority_issue",
  "existing-high-priority": "existing_high_priority_issue",
  "every-event": "every_event",
};
export const ALERT_TRIGGER_NAMES = Object.keys(TRIGGERS);

export type AlertMutationFlags = {
  readonly name?: string;
  readonly trigger?: string[];
  readonly action?: string[];
  readonly filter?: string[];
  readonly "filter-match"?: "all" | "any";
  readonly frequency?: number;
  readonly config?: string;
  readonly "action-filter"?: string[];
  readonly monitor?: string[];
  readonly project?: string;
  readonly environment?: string;
  readonly owner?: string;
  readonly enabled?: boolean;
  readonly "dry-run": boolean;
};

export const ALERT_MUTATION_FLAGS = {
  name: {
    kind: "parsed",
    parse: parseText,
    optional: true,
    brief: "Alert name",
  },
  trigger: {
    kind: "parsed",
    parse: choiceListParser(ALERT_TRIGGER_NAMES),
    variadic: true,
    optional: true,
    brief:
      "Trigger name, native condition JSON, or full trigger group JSON (repeatable)",
  },
  action: {
    kind: "parsed",
    parse: parseText,
    variadic: true,
    optional: true,
    brief: "Native action JSON for the first action-filter group (repeatable)",
  },
  filter: {
    kind: "parsed",
    parse: parseText,
    variadic: true,
    optional: true,
    brief:
      "Native condition JSON for the first action-filter group (repeatable)",
  },
  "filter-match": {
    kind: "parsed",
    parse: choiceParser(["all", "any"] as const, (value) => {
      if (value !== "all" && value !== "any") {
        throw new ValidationError(
          "filter-match must be all or any.",
          "filter-match",
        );
      }
      return value;
    }),
    optional: true,
    brief: "First action-filter group logic: all or any",
  },
  frequency: {
    kind: "parsed",
    parse: numberParser,
    optional: true,
    brief: "config.frequency in minutes (0 or greater)",
  },
  config: {
    kind: "parsed",
    parse: parseText,
    optional: true,
    brief: "Complete native workflow config JSON",
  },
  "action-filter": {
    kind: "parsed",
    parse: parseText,
    variadic: true,
    optional: true,
    brief:
      "Complete native action-filter group JSON; replaces all groups (repeatable or JSON array)",
  },
  monitor: {
    kind: "parsed",
    parse: parseText,
    variadic: true,
    optional: true,
    brief:
      "Monitor IDs to connect (repeatable, comma-separated; empty string clears)",
  },
  project: {
    kind: "parsed",
    parse: parseProjectSlug,
    optional: true,
    brief: "Select a project's issues and activity (replaces monitor links)",
  },
  environment: {
    kind: "parsed",
    parse: parseEnvironment,
    optional: true,
    brief: "Environment (empty string clears)",
  },
  owner: {
    kind: "parsed",
    parse: parseOwner,
    optional: true,
    brief: "Owner: user:<id> or team:<id> (empty string clears)",
  },
  enabled: {
    kind: "parsed",
    parse: choiceParser(["true", "false"] as const, (value) => {
      if (value !== "true" && value !== "false") {
        throw new ValidationError("enabled must be true or false.", "enabled");
      }
      return value === "true";
    }),
    optional: true,
    brief: "Whether this alert is enabled: true or false",
  },
} as const;

/** Project selection is explicit; resolve its existing issue stream. */
export async function resolveAlertMonitorFlags(
  org: string,
  flags: AlertMutationFlags,
): Promise<AlertMutationFlags> {
  if (flags.project === undefined) return flags;
  if (flags.monitor !== undefined) {
    throw new ValidationError(
      "Use --project or --monitor, not both.",
      "project",
    );
  }
  const project = flags.project.trim();
  if (!project || project === "-1") {
    throw new ValidationError("project must select one project.", "project");
  }
  const id = await resolveProjectAlertMonitorId(org, project);
  return { ...flags, monitor: [id] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError(`${field} must be valid JSON.`, field);
  }
}

function parseObject(raw: string, field: string): Record<string, unknown> {
  const value = parseJson(raw, field);
  if (!isObject(value)) {
    throw new ValidationError(`${field} must be a JSON object.`, field);
  }
  return value;
}

function parseObjects(
  values: readonly string[],
  field: string,
): Record<string, unknown>[] {
  return values.flatMap((raw) => {
    const value = parseJson(raw, field);
    const entries: unknown[] = Array.isArray(value) ? value : [value];
    if (!entries.every(isObject)) {
      throw new ValidationError(`${field} must contain JSON objects.`, field);
    }
    return entries;
  });
}

export function parseMonitorIds(values: readonly string[]): number[] {
  return values
    .flatMap((raw) => raw.split(","))
    .filter((raw) => raw.trim() !== "")
    .map((raw) => {
      const id = Number(raw);
      if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(id) || id <= 0) {
        throw new ValidationError(
          "monitor must contain positive integer IDs.",
          "monitor",
        );
      }
      return id;
    });
}

function parseTriggers(values: readonly string[]): Record<string, unknown> {
  const entries = values.flatMap((raw) => {
    if (raw.trim().startsWith("{") || raw.trim().startsWith("[")) {
      return parseObjects([raw], "trigger");
    }
    return raw.split(",").map((name) => {
      const key = name.trim().toLowerCase().replaceAll("_", "-");
      const type =
        TRIGGERS[key] ??
        Object.values(TRIGGERS).find((value) => value === name.trim());
      if (!type) {
        throw new ValidationError(
          `Unknown trigger '${name}'. Use ${ALERT_TRIGGER_NAMES.join(", ")} or native JSON.`,
          "trigger",
        );
      }
      return { type, comparison: true, conditionResult: true };
    });
  });
  const [first] = entries;
  if (entries.length === 1 && first && "logicType" in first) {
    return first;
  }
  if (entries.some((entry) => "logicType" in entry)) {
    throw new ValidationError(
      "Pass one complete trigger group, or a list of trigger conditions, not both.",
      "trigger",
    );
  }
  return { logicType: "any-short", conditions: entries };
}

/**
 * Sentry requires name on PUT and defaults omitted enabled to true. Include
 * both, but omit untouched config/groups/links: the backend preserves them.
 * When changing a group, retain every other group and all nested member IDs.
 */
function buildBody(
  flags: AlertMutationFlags,
  current?: Alert,
): Record<string, unknown> {
  const name = flags.name ?? current?.name;
  if (!name?.trim()) {
    throw new ValidationError(
      "Alert name is required and cannot be empty.",
      "name",
    );
  }
  if (
    flags["action-filter"] !== undefined &&
    (flags.action !== undefined ||
      flags.filter !== undefined ||
      flags["filter-match"] !== undefined)
  ) {
    throw new ValidationError(
      "Use --action-filter or --action/--filter/--filter-match, not both.",
      "action-filter",
    );
  }
  const body: Record<string, unknown> = {
    name,
    enabled: flags.enabled ?? current?.enabled ?? true,
  };
  if (flags.monitor !== undefined) {
    body.detectorIds = parseMonitorIds(flags.monitor);
  }
  if (flags.config !== undefined) {
    body.config = parseObject(flags.config, "config");
  }
  if (flags.frequency !== undefined) {
    if (!Number.isSafeInteger(flags.frequency) || flags.frequency < 0) {
      throw new ValidationError(
        "frequency must be a nonnegative integer in minutes.",
        "frequency",
      );
    }
    body.config = {
      ...(isObject(body.config) ? body.config : current?.config),
      frequency: flags.frequency,
    };
  }
  if (flags.trigger !== undefined) {
    const triggers = parseTriggers(flags.trigger);
    body.triggers = { ...current?.triggers, ...triggers };
  }
  if (flags["action-filter"] !== undefined) {
    body.actionFilters = parseObjects(flags["action-filter"], "action-filter");
  } else if (
    flags.action !== undefined ||
    flags.filter !== undefined ||
    flags["filter-match"] !== undefined
  ) {
    const groups = [...(current?.actionFilters ?? [])];
    const first = {
      logicType: "all",
      conditions: [],
      actions: [],
      ...groups[0],
    };
    if (flags.action !== undefined) {
      first.actions = parseObjects(flags.action, "action");
    }
    if (flags.filter !== undefined) {
      first.conditions = parseObjects(flags.filter, "filter");
    }
    if (flags["filter-match"] !== undefined) {
      first.logicType = flags["filter-match"] === "any" ? "any-short" : "all";
    }
    groups[0] = first;
    body.actionFilters = groups;
  }
  if (flags.environment !== undefined) {
    body.environment = flags.environment || null;
  }
  if (flags.owner !== undefined) {
    body.owner = flags.owner || null;
  }
  return body;
}

// The generated SDK restricts conditions more narrowly than the source validator;
// native JSON is deliberately forwarded unchanged for backend validation.
export function buildAlertCreateBody(
  flags: AlertMutationFlags,
): AlertCreateBody {
  return buildBody(flags) as AlertCreateBody;
}

export function buildAlertUpdateBody(
  flags: AlertMutationFlags,
  current: Alert,
): AlertUpdateBody {
  const changed = Object.keys(ALERT_MUTATION_FLAGS).some(
    (key) => flags[key as keyof AlertMutationFlags] !== undefined,
  );
  if (!changed) {
    throw new ValidationError("Set at least one field to edit.", "flags");
  }
  return buildBody(flags, current) as AlertUpdateBody;
}
