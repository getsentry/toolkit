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
const DEFAULTS_URL = "defaults.url";
const DEFAULTS_HEADERS = "defaults.headers";
const DEFAULTS_CA_CERT = "defaults.ca-cert";

/** Names of the on/off preferences, in display order. */
export const ON_OFF_PREFERENCES = [
  "telemetry",
  "agent-skills",
  "graphics",
  "tips",
] as const;

/** Name of an on/off preference. */
export type OnOffPreference = (typeof ON_OFF_PREFERENCES)[number];

/** Metadata key an on/off preference is stored under. */
function onOffKey(name: OnOffPreference): `defaults.${OnOffPreference}` {
  return `defaults.${name}`;
}

/** All metadata keys used for defaults (for bulk operations) */
const ALL_DEFAULTS_KEYS = [
  DEFAULTS_ORG,
  DEFAULTS_PROJECT,
  DEFAULTS_URL,
  DEFAULTS_HEADERS,
  DEFAULTS_CA_CERT,
  ...ON_OFF_PREFERENCES.map(onOffKey),
];

/**
 * State of all persistent defaults. On/off preferences are "on", "off", or
 * null (= default enabled).
 */
export type DefaultsState = {
  /** Default organization slug, or null if unset */
  organization: string | null;
  /** Default project slug, or null if unset */
  project: string | null;
  /** Default Sentry instance URL, or null if unset */
  url: string | null;
  /** Custom HTTP headers for self-hosted proxy auth, or null if unset */
  headers: string | null;
  /** Path to a PEM file with custom CA certificates, or null if unset */
  "ca-cert": string | null;
} & Record<OnOffPreference, "on" | "off" | null>;

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
 * Read a persistent on/off preference.
 *
 * @returns `true` if explicitly enabled, `false` if explicitly disabled,
 *   `undefined` if no preference is stored (callers should default to enabled)
 */
export function getOnOffPreference(name: OnOffPreference): boolean | undefined {
  const key = onOffKey(name);
  const value = parseOnOffValue(getMetadata(getDatabase(), [key]).get(key));
  return value === null ? undefined : value === "on";
}

/**
 * Set or clear a persistent on/off preference.
 * Pass `null` to remove it (callers will default to enabled).
 */
export function setOnOffPreference(
  name: OnOffPreference,
  enabled: boolean | null,
): void {
  const key = onOffKey(name);
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
    url: m.get(DEFAULTS_URL) ?? null,
    headers: m.get(DEFAULTS_HEADERS) ?? null,
    "ca-cert": m.get(DEFAULTS_CA_CERT) ?? null,
    ...(Object.fromEntries(
      ON_OFF_PREFERENCES.map((name) => [
        name,
        parseOnOffValue(m.get(onOffKey(name))),
      ]),
    ) as Record<OnOffPreference, "on" | "off" | null>),
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
