/**
 * Persistent CLI defaults stored in the metadata KV table.
 *
 * All defaults use metadata keys prefixed with `defaults.`:
 * - `defaults.org` — default organization slug
 * - `defaults.project` — default project slug
 * - `defaults.telemetry` — telemetry preference (`"on"` / `"off"`)
 * - `defaults.url` — Sentry instance URL (for self-hosted)
 * - `defaults.agent-skills` — agent skill install preference (`"on"` / `"off"`)
 * - `defaults.graphics` — inline terminal graphics preference (`"on"` / `"off"`)
 * - `defaults.tips` — `Tip:` hint preference (`"on"` / `"off"`)
 */

import { getDatabase } from "./index.js";
import { clearMetadata, getMetadata, setMetadata } from "./utils.js";

const DEFAULTS_ORG = "defaults.org";
const DEFAULTS_PROJECT = "defaults.project";
const DEFAULTS_TELEMETRY = "defaults.telemetry";
const DEFAULTS_URL = "defaults.url";
const DEFAULTS_HEADERS = "defaults.headers";
const DEFAULTS_CA_CERT = "defaults.ca-cert";
const DEFAULTS_AGENT_SKILLS = "defaults.agent-skills";
const DEFAULTS_GRAPHICS = "defaults.graphics";
const DEFAULTS_TIPS = "defaults.tips";

/** All metadata keys used for defaults (for bulk operations) */
const ALL_DEFAULTS_KEYS = [
  DEFAULTS_ORG,
  DEFAULTS_PROJECT,
  DEFAULTS_TELEMETRY,
  DEFAULTS_URL,
  DEFAULTS_HEADERS,
  DEFAULTS_CA_CERT,
  DEFAULTS_AGENT_SKILLS,
  DEFAULTS_GRAPHICS,
  DEFAULTS_TIPS,
];

/** State of all persistent defaults */
export type DefaultsState = {
  /** Default organization slug, or null if unset */
  organization: string | null;
  /** Default project slug, or null if unset */
  project: string | null;
  /** Telemetry preference: "on", "off", or null (= default enabled) */
  telemetry: "on" | "off" | null;
  /** Default Sentry instance URL, or null if unset */
  url: string | null;
  /** Custom HTTP headers for self-hosted proxy auth, or null if unset */
  headers: string | null;
  /** Path to a PEM file with custom CA certificates, or null if unset */
  "ca-cert": string | null;
  /** Agent skill install preference: "on", "off", or null (= default enabled) */
  "agent-skills": "on" | "off" | null;
  /** Inline terminal graphics preference: "on", "off", or null (= default enabled) */
  graphics: "on" | "off" | null;
  /** `Tip:` hint preference: "on", "off", or null (= default enabled) */
  tips: "on" | "off" | null;
};

/** Parse a raw "on" / "off" metadata value to a typed "on" | "off" | null. */
function parseOnOffValue(val: string | undefined): "on" | "off" | null {
  if (val === "on") {
    return "on";
  }
  if (val === "off") {
    return "off";
  }
  return null;
}

/**
 * Read an on/off preference stored under `key`.
 *
 * @returns `true` if explicitly enabled, `false` if explicitly disabled,
 *   `undefined` if no preference is stored (callers should default to enabled)
 */
function getOnOffPreference(key: string): boolean | undefined {
  const value = parseOnOffValue(getMetadata(getDatabase(), [key]).get(key));
  return value === null ? undefined : value === "on";
}

/**
 * Store an on/off preference under `key`.
 * Pass `null` to remove it (callers will default to enabled).
 */
function setOnOffPreference(key: string, enabled: boolean | null): void {
  const db = getDatabase();
  if (enabled === null) {
    clearMetadata(db, [key]);
  } else {
    setMetadata(db, { [key]: enabled ? "on" : "off" });
  }
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

/** Get the default organization slug, or null if not set. */
export function getDefaultOrganization(): string | null {
  const db = getDatabase();
  const m = getMetadata(db, [DEFAULTS_ORG]);
  return m.get(DEFAULTS_ORG) ?? null;
}

/** Get the default project slug, or null if not set. */
export function getDefaultProject(): string | null {
  const db = getDatabase();
  const m = getMetadata(db, [DEFAULTS_PROJECT]);
  return m.get(DEFAULTS_PROJECT) ?? null;
}

/** Get the persistent telemetry preference (see {@link getOnOffPreference}). */
export function getTelemetryPreference(): boolean | undefined {
  return getOnOffPreference(DEFAULTS_TELEMETRY);
}

/** Get the persistent agent skill install preference (see {@link getOnOffPreference}). */
export function getAgentSkillsPreference(): boolean | undefined {
  return getOnOffPreference(DEFAULTS_AGENT_SKILLS);
}

/** Get the persistent inline-graphics preference (see {@link getOnOffPreference}). */
export function getGraphicsPreference(): boolean | undefined {
  return getOnOffPreference(DEFAULTS_GRAPHICS);
}

/** Get the persistent `Tip:` hint preference (see {@link getOnOffPreference}). */
export function getTipsPreference(): boolean | undefined {
  return getOnOffPreference(DEFAULTS_TIPS);
}

/** Get the default Sentry instance URL, or null if not set. */
export function getDefaultUrl(): string | null {
  const db = getDatabase();
  const m = getMetadata(db, [DEFAULTS_URL]);
  return m.get(DEFAULTS_URL) ?? null;
}

/**
 * Get the default custom headers string, or null if not set.
 * Format: semicolon-separated `Name: Value` pairs.
 */
export function getDefaultHeaders(): string | null {
  const db = getDatabase();
  const m = getMetadata(db, [DEFAULTS_HEADERS]);
  return m.get(DEFAULTS_HEADERS) ?? null;
}

/**
 * Get the stored CA certificate file path, or null if not set.
 * Used by `custom-ca.ts` as the highest-priority CA source.
 */
export function getDefaultCaCert(): string | null {
  const db = getDatabase();
  const m = getMetadata(db, [DEFAULTS_CA_CERT]);
  return m.get(DEFAULTS_CA_CERT) ?? null;
}

/**
 * Get all persistent defaults as a structured object.
 * Used by the `sentry cli defaults` show mode and JSON output.
 */
export function getAllDefaults(): DefaultsState {
  const db = getDatabase();
  const m = getMetadata(db, ALL_DEFAULTS_KEYS);
  return {
    organization: m.get(DEFAULTS_ORG) ?? null,
    project: m.get(DEFAULTS_PROJECT) ?? null,
    telemetry: parseOnOffValue(m.get(DEFAULTS_TELEMETRY)),
    url: m.get(DEFAULTS_URL) ?? null,
    headers: m.get(DEFAULTS_HEADERS) ?? null,
    "ca-cert": m.get(DEFAULTS_CA_CERT) ?? null,
    "agent-skills": parseOnOffValue(m.get(DEFAULTS_AGENT_SKILLS)),
    graphics: parseOnOffValue(m.get(DEFAULTS_GRAPHICS)),
    tips: parseOnOffValue(m.get(DEFAULTS_TIPS)),
  };
}

// ---------------------------------------------------------------------------
// Setters (null = clear the value)
// ---------------------------------------------------------------------------

/** Set or clear the default organization. Pass `null` to clear. */
export function setDefaultOrganization(value: string | null): void {
  const db = getDatabase();
  if (value === null) {
    clearMetadata(db, [DEFAULTS_ORG]);
  } else {
    setMetadata(db, { [DEFAULTS_ORG]: value });
  }
}

/** Set or clear the default project. Pass `null` to clear. */
export function setDefaultProject(value: string | null): void {
  const db = getDatabase();
  if (value === null) {
    clearMetadata(db, [DEFAULTS_PROJECT]);
  } else {
    setMetadata(db, { [DEFAULTS_PROJECT]: value });
  }
}

/** Set or clear the persistent telemetry preference (see {@link setOnOffPreference}). */
export function setTelemetryPreference(enabled: boolean | null): void {
  setOnOffPreference(DEFAULTS_TELEMETRY, enabled);
}

/** Set or clear the persistent agent skill install preference (see {@link setOnOffPreference}). */
export function setAgentSkillsPreference(enabled: boolean | null): void {
  setOnOffPreference(DEFAULTS_AGENT_SKILLS, enabled);
}

/** Set or clear the persistent inline-graphics preference (see {@link setOnOffPreference}). */
export function setGraphicsPreference(enabled: boolean | null): void {
  setOnOffPreference(DEFAULTS_GRAPHICS, enabled);
}

/** Set or clear the persistent `Tip:` hint preference (see {@link setOnOffPreference}). */
export function setTipsPreference(enabled: boolean | null): void {
  setOnOffPreference(DEFAULTS_TIPS, enabled);
}

/** Set or clear the default Sentry instance URL. Pass `null` to clear. */
export function setDefaultUrl(url: string | null): void {
  const db = getDatabase();
  if (url === null) {
    clearMetadata(db, [DEFAULTS_URL]);
  } else {
    setMetadata(db, { [DEFAULTS_URL]: url });
  }
}

/**
 * Set or clear the default custom headers. Pass `null` to clear.
 * Value should be semicolon-separated `Name: Value` pairs.
 */
export function setDefaultHeaders(value: string | null): void {
  const db = getDatabase();
  if (value === null) {
    clearMetadata(db, [DEFAULTS_HEADERS]);
  } else {
    setMetadata(db, { [DEFAULTS_HEADERS]: value });
  }
}

/**
 * Set or clear the stored CA certificate file path. Pass `null` to clear.
 * The path should point to a PEM file containing CA certificates.
 */
export function setDefaultCaCert(path: string | null): void {
  const db = getDatabase();
  if (path === null) {
    clearMetadata(db, [DEFAULTS_CA_CERT]);
  } else {
    setMetadata(db, { [DEFAULTS_CA_CERT]: path });
  }
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/** Clear all persistent defaults (org, project, telemetry, url). */
export function clearAllDefaults(): void {
  const db = getDatabase();
  clearMetadata(db, ALL_DEFAULTS_KEYS);
}
