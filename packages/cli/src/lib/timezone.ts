/**
 * System timezone detection and repair.
 *
 * ## Why this exists
 *
 * All human-facing timestamps in the CLI — the `[tag 6:28:59 AM]` log prefix
 * emitted by consola, and every `toLocaleString()`/`toLocaleTimeString()` call
 * in the formatters — are rendered by the JavaScript runtime using its notion
 * of the "local" timezone. That notion comes from ICU/`process.env.TZ`.
 *
 * The CLI ships as standalone Node SEA binaries (see `script/build.ts`). SEA
 * binaries, containers, and other minimal runtimes frequently lack the OS
 * timezone wiring that a normal `node`/`bun` install has. When the runtime
 * cannot resolve the system timezone it silently falls back to **UTC** —
 * `Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC"` and
 * `Date.prototype.getTimezoneOffset()` returns `0`. A user in US/Pacific then
 * sees UTC timestamps in the logs, "a timezone completely different than where
 * they are", even though their OS clock is set correctly.
 *
 * ## What this does
 *
 * {@link initTimezone} runs once at process startup, *before* any `Date` is
 * formatted. If the user has already set `TZ` we respect it and do nothing.
 * Otherwise, when the runtime looks like it fell back to UTC, we ask the OS
 * directly for its configured zone and, if it differs, set `process.env.TZ`
 * so the runtime re-resolves against the correct zone.
 *
 * Detection is best-effort and never throws — a failure to detect leaves the
 * runtime exactly as it was (UTC fallback), which is no worse than today.
 *
 * @module
 */

import { execSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

/** IANA name the runtime reports when it has no real timezone data. */
const UTC_FALLBACK = "UTC";

/**
 * Marker path segment used by the tz database. A resolved `/etc/localtime`
 * symlink looks like `/usr/share/zoneinfo/America/Los_Angeles`; everything
 * after this segment is the IANA name.
 */
const ZONEINFO_MARKER = "/zoneinfo/";

/**
 * Read the timezone the JS runtime currently believes it is in.
 *
 * Returns the IANA name from `Intl` (e.g. `"America/Los_Angeles"`), or
 * `"UTC"` both when the machine genuinely is UTC and when the runtime fell
 * back to UTC because it could not resolve a zone. The two cases are
 * indistinguishable from `Intl` alone — that is what {@link osReportsNonUtc}
 * disambiguates.
 */
export function runtimeTimezone(): string {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || UTC_FALLBACK;
  } catch {
    return UTC_FALLBACK;
  }
}

/**
 * Extract an IANA zone name from a resolved `/etc/localtime` symlink target.
 *
 * @param linkTarget - The path `/etc/localtime` points at
 * @returns The IANA name (e.g. `"America/Los_Angeles"`) or `null` if the
 *   target does not contain a zoneinfo path.
 */
function ianaFromZoneinfoPath(linkTarget: string): string | null {
  const idx = linkTarget.indexOf(ZONEINFO_MARKER);
  if (idx === -1) {
    return null;
  }
  const name = linkTarget.slice(idx + ZONEINFO_MARKER.length).trim();
  return name.length > 0 ? name : null;
}

/**
 * Ask the operating system for its configured IANA timezone.
 *
 * This bypasses the runtime's (possibly missing) ICU wiring and reads the OS
 * configuration directly. Strategies are tried in order and the first success
 * wins:
 *
 * - **Linux**: `/etc/timezone` contents, then the `/etc/localtime` symlink.
 * - **macOS**: the `/etc/localtime` symlink target.
 * - **Windows**: `tzutil /g` returns a Windows zone name; when that maps to a
 *   known IANA name we use it, otherwise we return `null` and the caller falls
 *   back to a fixed-offset zone.
 *
 * @returns An IANA timezone name, or `null` if the OS zone could not be
 *   determined. Never throws.
 */
export function detectOsTimezone(): string | null {
  if (process.platform === "win32") {
    return detectWindowsTimezone();
  }
  return detectUnixTimezone();
}

/**
 * Detect the OS timezone on Linux/macOS from the tz database configuration.
 */
function detectUnixTimezone(): string | null {
  // /etc/timezone is the canonical, greppable source on Debian/Ubuntu and
  // many container images. It holds a single IANA name.
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const contents = readFileSync("/etc/timezone", "utf-8").trim();
    if (contents.length > 0 && contents !== UTC_FALLBACK) {
      return contents;
    }
  } catch {
    // Not present on macOS and some distros — fall through to the symlink.
  }

  // /etc/localtime is a symlink into the zoneinfo database on macOS and most
  // Linux distros. Its target encodes the IANA name.
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const target = readlinkSync("/etc/localtime");
    return ianaFromZoneinfoPath(target);
  } catch {
    return null;
  }
}

/**
 * Detect the OS timezone on Windows via `tzutil /g`, translating the returned
 * Windows zone name to IANA where possible.
 */
function detectWindowsTimezone(): string | null {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const windowsName = execSync("tzutil /g", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return WINDOWS_TO_IANA[windowsName] ?? null;
  } catch {
    return null;
  }
}

/**
 * Minimal Windows-zone → IANA map covering the common US and European zones a
 * developer is most likely to hit. Unmapped zones fall back to a fixed-offset
 * zone via {@link fixedOffsetZone}, so this map is deliberately small rather
 * than exhaustive.
 */
const WINDOWS_TO_IANA: Record<string, string> = {
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "US Mountain Standard Time": "America/Phoenix",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  UTC: "UTC",
};

/**
 * Build a fixed-offset IANA zone name from a UTC offset in minutes.
 *
 * `Date.prototype.getTimezoneOffset()` returns minutes *behind* UTC (positive
 * for zones west of UTC), so US/Pacific is `+420`. The `Etc/GMT` zones invert
 * the sign — `Etc/GMT+8` is UTC−8 — so this reproduces that convention.
 *
 * The result has no DST rules, so it is only a last-resort fallback when we
 * cannot obtain a proper IANA name. It still fixes the "wrong by 7 hours"
 * symptom that the bug report is about.
 *
 * @param offsetMinutes - Value from `getTimezoneOffset()` (minutes behind UTC)
 * @returns A fixed-offset zone name like `"Etc/GMT+8"`, or `null` for UTC.
 */
export function fixedOffsetZone(offsetMinutes: number): string | null {
  if (!Number.isFinite(offsetMinutes) || offsetMinutes === 0) {
    return null;
  }
  // Whole-hour offsets only; the Etc/GMT zones don't express minutes.
  const hours = Math.trunc(offsetMinutes / 60);
  if (hours === 0) {
    return null;
  }
  // getTimezoneOffset is positive west of UTC; Etc/GMT+N is also west of UTC,
  // so the sign already matches.
  const sign = hours > 0 ? "+" : "-";
  return `Etc/GMT${sign}${Math.abs(hours)}`;
}

/**
 * Whether the OS clock disagrees with the runtime's UTC belief.
 *
 * `getTimezoneOffset()` reads the process's local offset. In the broken state
 * it returns `0` (matching the UTC fallback). A non-zero value means the OS
 * itself is not UTC and the runtime's UTC resolution is wrong.
 *
 * @returns `true` when the local offset is non-zero.
 */
function osReportsNonUtc(): boolean {
  return new Date().getTimezoneOffset() !== 0;
}

/**
 * Detect and repair a broken (UTC-fallback) timezone at process startup.
 *
 * Idempotent and safe to call multiple times. The behavior is:
 *
 * 1. If `TZ` is already set (by the user or a previous call), do nothing —
 *    an explicit choice always wins.
 * 2. If the runtime did not fall back to UTC, do nothing — it resolved a real
 *    zone and every `toLocaleString()` will already be correct.
 * 3. If the runtime is UTC but the OS clock reports a non-UTC offset, ask the
 *    OS for its IANA zone (falling back to a fixed-offset zone) and export it
 *    via `process.env.TZ` so the runtime re-resolves against it.
 *
 * Must run before any timestamp is formatted (i.e. very early in `bin.ts`).
 *
 * @returns The IANA/offset zone that was applied, or `null` when nothing
 *   changed (already set, already correct, or detection failed).
 */
export function initTimezone(): string | null {
  // An explicit TZ — from the user's shell or a prior invocation — is
  // authoritative. Never override it.
  if (process.env.TZ) {
    return null;
  }

  // Runtime already resolved a real zone; no repair needed.
  if (runtimeTimezone() !== UTC_FALLBACK) {
    return null;
  }

  // Runtime says UTC. If the OS agrees (offset 0), it really is UTC — leave it.
  if (!osReportsNonUtc()) {
    return null;
  }

  // Broken state confirmed: runtime fell back to UTC but the OS is elsewhere.
  const zone =
    detectOsTimezone() ?? fixedOffsetZone(new Date().getTimezoneOffset());
  if (!zone || zone === UTC_FALLBACK) {
    return null;
  }

  process.env.TZ = zone;
  return zone;
}

/**
 * Format a `Date` as a local-time clock string for the log prefix.
 *
 * Renders 24-hour `HH:MM:SS` in the machine's local timezone. Unlike consola's
 * default `date.toLocaleTimeString()` this does **not** depend on ICU being
 * able to resolve a zone: it derives the local wall-clock time from the UTC
 * time and `getTimezoneOffset()`, which reflects the OS offset even in runtimes
 * that cache a stale UTC formatter (observed under some SEA/Bun builds). After
 * {@link initTimezone} has set `TZ`, `getTimezoneOffset()` returns the corrected
 * offset, so this stays consistent with the rest of the CLI's output.
 *
 * The 24-hour format also removes the AM/PM ambiguity of the previous prefix,
 * which is friendlier for logs shared across regions.
 *
 * @param date - The log record's timestamp
 * @returns A `HH:MM:SS` string in local time (e.g. `"06:28:59"`)
 */
export function formatLogTime(date: Date): string {
  // getTimezoneOffset() is minutes behind UTC (positive west of UTC). Shifting
  // the epoch by it and reading UTC getters yields local wall-clock components
  // without relying on the ICU formatter.
  const localMs = date.getTime() - date.getTimezoneOffset() * 60_000;
  const local = new Date(localMs);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  const ss = String(local.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
