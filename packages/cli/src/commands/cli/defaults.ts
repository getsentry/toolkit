/**
 * sentry cli defaults
 *
 * View and manage persistent CLI default settings.
 *
 * Supports these defaults:
 * - `org` / `organization` — default organization slug
 * - `project` — default project slug
 * - `telemetry` — telemetry preference (on/off)
 * - `url` — Sentry instance URL (for self-hosted)
 * - `ca-cert` — path to PEM file with custom CA certificates
 */

import { resolve } from "node:path";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { choiceParser } from "../../lib/completion-target.js";
import { normalizeUrl } from "../../lib/constants.js";
import { readCaCertFile } from "../../lib/custom-ca.js";
import { parseCustomHeaders } from "../../lib/custom-headers.js";
import {
  clearAllDefaults,
  getOnOffPreference,
  ON_OFF_PREFERENCES,
  type OnOffPreference,
  setOnOffPreference,
  type DefaultsState,
  getAllDefaults,
  getDefaultCaCert,
  getDefaultHeaders,
  getDefaultOrganization,
  getDefaultProject,
  getDefaultUrl,
  setDefaultCaCert,
  setDefaultHeaders,
  setDefaultOrganization,
  setDefaultProject,
  setDefaultUrl,
} from "../../lib/db/defaults.js";
import { ValidationError } from "../../lib/errors.js";
import { formatDefaultsResult } from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { prompt } from "../../lib/prompt.js";
import {
  FORCE_FLAG,
  guardNonInteractive,
  isConfirmationBypassed,
  YES_FLAG,
} from "../../lib/mutate-command.js";
import { parseBoolValue } from "../../lib/parse-bool.js";
import { computeTelemetryEffective } from "../../lib/telemetry.js";
import { resetTipsCache } from "../../lib/tips.js";

// ---------------------------------------------------------------------------
// Defaults registry — maps canonical keys to get/set/clear handlers
// ---------------------------------------------------------------------------

/** Canonical key names matching DefaultsState fields */
type DefaultKey =
  | "organization"
  | "project"
  | OnOffPreference
  | "url"
  | "headers"
  | "ca-cert";

/** Handler for reading, writing, and clearing a single default */
type DefaultHandler = {
  /** Get current value for display / change tracking */
  get: () => string | boolean | null;
  /** Validate and store a new value */
  set: (value: string) => void;
  /** Clear the stored value */
  clear: () => void;
};

/** Validate that a slug value is non-empty after trimming whitespace. */
function validateSlug(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(`${label} cannot be empty.`, label.toLowerCase());
  }
  return trimmed;
}

/** Side effects to run after an on/off preference changes. */
const ON_OFF_CHANGE_HOOKS: Partial<Record<OnOffPreference, () => void>> = {
  tips: resetTipsCache,
};

/**
 * Build the handler for an on/off preference. Accepts on/off, yes/no,
 * true/false, or 1/0 and reports the stored value as "on", "off", or null.
 */
function onOffHandler(name: OnOffPreference): DefaultHandler {
  const store = (enabled: boolean | null) => {
    setOnOffPreference(name, enabled);
    ON_OFF_CHANGE_HOOKS[name]?.();
  };
  return {
    get: () => {
      const pref = getOnOffPreference(name);
      if (pref === undefined) {
        return null;
      }
      return pref ? "on" : "off";
    },
    set: (value) => {
      const parsed = parseBoolValue(value);
      if (parsed === null) {
        throw new ValidationError(
          `Invalid ${name} value: '${value}'. Use on/off, yes/no, true/false, or 1/0.`,
          name,
        );
      }
      store(parsed);
    },
    clear: () => store(null),
  };
}

/** Registry of all supported defaults with their handlers */
const DEFAULTS_REGISTRY: Record<DefaultKey, DefaultHandler> = {
  organization: {
    get: getDefaultOrganization,
    set: (value) => setDefaultOrganization(validateSlug(value, "Organization")),
    clear: () => setDefaultOrganization(null),
  },
  project: {
    get: getDefaultProject,
    set: (value) => setDefaultProject(validateSlug(value, "Project")),
    clear: () => setDefaultProject(null),
  },
  ...(Object.fromEntries(
    ON_OFF_PREFERENCES.map((name) => [name, onOffHandler(name)]),
  ) as Record<OnOffPreference, DefaultHandler>),
  url: {
    get: getDefaultUrl,
    set: (value) => {
      const normalized = normalizeUrl(value);
      if (!normalized) {
        throw new ValidationError("URL cannot be empty.", "url");
      }
      try {
        new URL(normalized);
      } catch {
        throw new ValidationError(
          `Invalid URL: '${value}'. Provide a valid URL (e.g., https://sentry.example.com).`,
          "url",
        );
      }
      setDefaultUrl(normalized);
    },
    clear: () => setDefaultUrl(null),
  },
  headers: {
    get: getDefaultHeaders,
    set: (value) => {
      // Validate the header string by parsing it — throws ConfigError on bad input
      parseCustomHeaders(value);
      setDefaultHeaders(value);
    },
    clear: () => setDefaultHeaders(null),
  },
  "ca-cert": {
    get: getDefaultCaCert,
    set: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        throw new ValidationError(
          "CA certificate path cannot be empty.",
          "ca-cert",
        );
      }
      const resolved = resolve(trimmed);
      const result = readCaCertFile(resolved);
      if (!result.ok) {
        throw new ValidationError(result.reason, "ca-cert");
      }
      setDefaultCaCert(resolved);
    },
    clear: () => setDefaultCaCert(null),
  },
};

// ---------------------------------------------------------------------------
// Key aliases — maps shorthand names to canonical DefaultKey
// ---------------------------------------------------------------------------

/** Shorthand aliases for canonical keys (e.g., "org" → "organization") */
const KEY_ALIASES: Partial<Record<string, DefaultKey>> = {
  org: "organization",
  ca: "ca-cert",
  cert: "ca-cert",
  "ca-certs": "ca-cert",
};

/**
 * Words that mean "show all defaults" when passed as the only positional.
 *
 * Other commands use `list` subcommands, so users and agents often try
 * `sentry cli defaults list`. Treat these like running with no arguments.
 */
const SHOW_ALL_VERBS = new Set(["list", "ls", "show"]);

/** Resolve a user-provided key string to a canonical key, or null if unknown */
function normalizeKey(key: string): DefaultKey | null {
  const lower = key.toLowerCase();
  return (
    KEY_ALIASES[lower] ??
    (lower in DEFAULTS_REGISTRY ? (lower as DefaultKey) : null)
  );
}

// ---------------------------------------------------------------------------
// Result type + telemetry effective state
// ---------------------------------------------------------------------------

/** Result data for the defaults command */
export type DefaultsResult = {
  /** The operation performed */
  action: "show" | "set" | "clear" | "clear-all";
  /** Current state of all defaults after the operation */
  defaults: DefaultsState;
  /** Effective telemetry state considering env var overrides (display-only) */
  telemetryEffective?: {
    enabled: boolean;
    source: string;
  };
  /** What was changed (for set/clear actions) */
  changed?: {
    key: string;
    previousValue: string | boolean | null;
    newValue: string | boolean | null;
  };
};

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const log = logger.withTag("defaults");

export const defaultsCommand = buildCommand({
  auth: false,
  docs: {
    brief: "View and manage default settings",
    fullDescription:
      "View and manage persistent CLI default settings.\n\n" +
      "With no arguments, shows all current defaults. Pass a key and value\n" +
      "to set a default, or use `--clear` to remove defaults.\n\n" +
      "## Recognized keys\n\n" +
      "| Key | Description |\n" +
      "|-----|------------|\n" +
      "| `org` | Default organization slug |\n" +
      "| `project` | Default project slug |\n" +
      "| `telemetry` | Telemetry preference (on/off, yes/no, true/false, 1/0) |\n" +
      "| `agent-skills` | Install agent skills on setup/upgrade (on/off, yes/no, true/false, 1/0) |\n" +
      "| `graphics` | Render images inline on capable terminals (on/off, yes/no, true/false, 1/0) |\n" +
      "| `tips` | Show `Tip:` hints in command output (on/off, yes/no, true/false, 1/0). `SENTRY_DISABLE_TIPS` overrides it at runtime |\n" +
      "| `url` | Sentry instance URL (for self-hosted installations) |\n" +
      "| `headers` | Custom HTTP headers for self-hosted proxies (semicolon-separated `Name: Value`) |\n" +
      "| `ca-cert` | Path to PEM file with custom CA certificates (for corporate proxies) |",
    examples: [
      {
        description: "Show all current defaults",
        command: "sentry cli defaults",
      },
      {
        description: "Same as above (aliases: ls, show)",
        command: "sentry cli defaults list",
      },
      {
        description: "Set the default organization",
        command: "sentry cli defaults org my-org",
      },
      {
        description: "Set the default project",
        command: "sentry cli defaults project my-project",
      },
      {
        description: "Set the default Sentry URL (self-hosted)",
        command: "sentry cli defaults url https://sentry.example.com",
      },
      {
        description:
          "Set custom HTTP headers (self-hosted, e.g. for IAP/proxies)",
        command: 'sentry cli defaults headers "X-IAP: token"',
      },
      {
        description:
          "Set a custom CA certificate (self-hosted, behind a TLS proxy)",
        command: "sentry cli defaults ca-cert /path/to/ca.pem",
      },
      {
        description: "Disable telemetry",
        command: "sentry cli defaults telemetry off",
      },
      {
        description: "Stop installing agent skills on upgrade",
        command: "sentry cli defaults agent-skills off",
      },
      {
        description: "Disable inline terminal images",
        command: "sentry cli defaults graphics off",
      },
      {
        description: "Hide Tip: hints in command output",
        command: "sentry cli defaults tips off",
      },
      {
        description: "Clear a single default",
        command: "sentry cli defaults org --clear",
      },
      {
        description: "Clear all defaults without prompting",
        command: "sentry cli defaults --clear --yes",
      },
    ],
  },
  output: {
    human: formatDefaultsResult,
    jsonExclude: ["telemetryEffective"],
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "Setting key and optional value",
        parse: choiceParser(Object.keys(DEFAULTS_REGISTRY)),
        placeholder: "key value",
      },
    },
    flags: {
      clear: {
        kind: "boolean",
        brief:
          "Clear the specified default, or all defaults if no key is given",
        default: false,
      },
      yes: YES_FLAG,
      force: FORCE_FLAG,
    },
    aliases: { y: "yes", f: "force" },
  },
  // sequential command dispatch
  async *func(
    this: SentryContext,
    flags: {
      readonly clear: boolean;
      readonly yes: boolean;
      readonly force: boolean;
    },
    ...args: string[]
  ) {
    const [rawKeyArg, valueArg, ...rest] = args;

    // Too many arguments
    if (rest.length > 0) {
      throw new ValidationError(
        "Too many arguments. Usage: sentry cli defaults [<key> [<value>]]",
        "args",
      );
    }

    // `list` / `ls` / `show` are aliases for showing all defaults
    const isShowVerb =
      rawKeyArg !== undefined && SHOW_ALL_VERBS.has(rawKeyArg.toLowerCase());
    if (isShowVerb && (valueArg !== undefined || flags.clear)) {
      throw new ValidationError(
        `'${rawKeyArg}' shows all defaults and takes no value or --clear. Use 'sentry cli defaults' to show all, or 'sentry cli defaults --clear' to clear all.`,
        "args",
      );
    }
    const keyArg = isShowVerb ? undefined : rawKeyArg;

    // No key specified — show all or clear all
    if (!keyArg) {
      if (flags.clear) {
        // Clear all defaults (with confirmation)
        guardNonInteractive(flags);
        if (!isConfirmationBypassed(flags)) {
          const confirmed = await prompt(
            `This will clear all defaults (${Object.keys(DEFAULTS_REGISTRY).join(", ")}). Continue?`,
            { type: "confirm" },
          );
          if (confirmed !== true) {
            return { hint: "Cancelled." };
          }
        }
        clearAllDefaults();
        resetTipsCache();
        yield new CommandOutput({
          action: "clear-all" as const,
          defaults: getAllDefaults(),
        });
        return { hint: "All defaults have been cleared." };
      }

      // Show all defaults
      yield new CommandOutput({
        action: "show" as const,
        defaults: getAllDefaults(),
        telemetryEffective: computeTelemetryEffective(),
      });
      return;
    }

    // Validate key
    const canonical = normalizeKey(keyArg);
    if (!canonical) {
      const validKeys = [
        ...Object.keys(DEFAULTS_REGISTRY),
        ...Object.keys(KEY_ALIASES),
      ];
      throw new ValidationError(
        `Unknown default '${keyArg}'. Valid keys: ${validKeys.join(", ")}`,
        "key",
      );
    }

    const handler = DEFAULTS_REGISTRY[canonical];

    // Key + --clear → clear specific default
    if (flags.clear) {
      if (valueArg !== undefined) {
        throw new ValidationError(
          `Cannot use --clear with a value. Use either 'sentry cli defaults ${keyArg} --clear' or 'sentry cli defaults ${keyArg} <value>'.`,
          "args",
        );
      }
      const previous = handler.get();
      handler.clear();
      yield new CommandOutput({
        action: "clear" as const,
        defaults: getAllDefaults(),
        changed: { key: canonical, previousValue: previous, newValue: null },
      });
      return;
    }

    // Key only, no value → show specific default
    if (valueArg === undefined) {
      yield new CommandOutput({
        action: "show" as const,
        defaults: getAllDefaults(),
        telemetryEffective:
          canonical === "telemetry" ? computeTelemetryEffective() : undefined,
      });
      return;
    }

    // Key + value → set default
    const previous = handler.get();
    handler.set(valueArg);
    const newValue = handler.get();

    yield new CommandOutput({
      action: "set" as const,
      defaults: getAllDefaults(),
      changed: { key: canonical, previousValue: previous, newValue },
    });

    // Show telemetry override warning when setting telemetry preference
    if (canonical === "telemetry") {
      const effective = computeTelemetryEffective();
      if (
        effective?.source.startsWith("env:") &&
        effective.enabled !== (newValue === "on")
      ) {
        log.warn(
          `Note: ${effective.source.slice("env:".length)} environment variable overrides this preference.`,
        );
      }
    }

    return;
  },
});
