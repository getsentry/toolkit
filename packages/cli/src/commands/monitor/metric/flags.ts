import { numberParser } from "../../../lib/command.js";
import {
  aggregateParser,
  choiceParser,
  parseEnvironment,
  parseOwner,
  parseText,
  parseWorkflowList,
} from "../../../lib/completion-target.js";
import { DRY_RUN_FLAG } from "../../../lib/mutate-command.js";
import {
  METRIC_MONITOR_DATASET_BRIEF,
  METRIC_MONITOR_SIGNAL_NAMES,
} from "../../../types/metric-monitor.js";
import {
  METRIC_MONITOR_FIELD_COMPLETION,
  parseEnabled,
} from "./mutation-utils.js";

/** Both mutations accept native detector settings; all unspecified edit fields stay untouched. */
export const monitorFlags = {
  name: {
    kind: "parsed",
    parse: parseText,
    optional: true,
    brief: "Monitor name",
  },
  query: {
    kind: "parsed",
    parse: parseText,
    optional: true,
    brief: "Query filter (empty string selects all matching events)",
  },
  aggregate: {
    kind: "parsed",
    parse: aggregateParser(METRIC_MONITOR_FIELD_COMPLETION),
    optional: true,
    brief: "Aggregate expression, e.g. count() or p95(span.duration)",
  },
  dataset: {
    kind: "parsed",
    parse: choiceParser(METRIC_MONITOR_SIGNAL_NAMES),
    optional: true,
    brief: METRIC_MONITOR_DATASET_BRIEF,
  },
  "time-window": {
    kind: "parsed",
    parse: numberParser,
    optional: true,
    brief: "Evaluation window in minutes (wire values are seconds)",
  },
  condition: {
    kind: "parsed",
    parse: parseText,
    variadic: true,
    optional: true,
    brief:
      "Native {type,comparison,conditionResult} JSON (repeatable; replaces all conditions)",
  },
  config: {
    kind: "parsed",
    parse: parseText,
    optional: true,
    brief:
      "Native detection config JSON: static, percent or dynamic; comparisonDelta is seconds",
  },
  critical: {
    kind: "parsed",
    parse: numberParser,
    optional: true,
    brief:
      "Critical threshold (creates native alert and resolution conditions)",
  },
  warning: {
    kind: "parsed",
    parse: numberParser,
    optional: true,
    brief: "Optional warning threshold, used with --critical",
  },
  resolve: {
    kind: "parsed",
    parse: numberParser,
    optional: true,
    brief: "Resolution threshold (defaults to --critical)",
  },
  comparison: {
    kind: "parsed",
    parse: choiceParser(["gt", "lt"]),
    optional: true,
    brief: "Threshold direction: gt or lt (default gt)",
  },
  environment: {
    kind: "parsed",
    parse: parseEnvironment,
    optional: true,
    brief: "Environment filter (empty string clears it)",
  },
  owner: {
    kind: "parsed",
    parse: parseOwner,
    optional: true,
    brief: "Owner actor, e.g. team:123 (empty string clears it)",
  },
  description: {
    kind: "parsed",
    parse: parseText,
    optional: true,
    brief: "Monitor description",
  },
  enabled: {
    kind: "parsed",
    parse: parseEnabled,
    optional: true,
    brief: "Enable or disable: true or false",
  },
  alert: {
    kind: "parsed",
    parse: parseWorkflowList,
    variadic: true,
    optional: true,
    brief:
      "Connected alert ID (repeatable or comma-separated; replaces workflowIds; empty clears)",
  },
  "dry-run": DRY_RUN_FLAG,
} as const;
