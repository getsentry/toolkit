/**
 * DSN-based envelope transport for Sentry's event ingestion pipeline.
 *
 * Unlike the Web API (which uses Bearer token auth), envelope ingestion
 * authenticates via the DSN's public key embedded in the request URL.
 * This is the same mechanism all Sentry SDKs use when reporting errors.
 *
 * Endpoint pattern:
 *   POST https://<host>/api/<projectId>/envelope/
 *        ?sentry_key=<publicKey>&sentry_version=7
 *   Content-Type: application/x-sentry-envelope
 */

import { getEnvelopeEndpointWithUrlEncodedAuth, makeDsn } from "@sentry/core";
import { detectDsn } from "../dsn/index.js";
import { ApiError, ConfigError, ValidationError } from "../errors.js";
import { logger } from "../logger.js";

const log = logger.withTag("envelope.transport");

/** Client name passed to getEnvelopeEndpointWithUrlEncodedAuth, which appends /<version> internally. */
const SENTRY_CLIENT = "sentry-cli";

/** Optional `--dsn` flag exposed by some ingest commands. */
export type DsnFlags = {
  dsn?: string;
};

/**
 * Build the ingest URL for a given DSN.
 *
 * Returns the full URL including auth query params, ready to POST to.
 * Throws ValidationError on an unparseable DSN.
 */
export function buildEnvelopeUrl(dsn: string): string {
  let dsnComponents: ReturnType<typeof makeDsn>;
  try {
    dsnComponents = makeDsn(dsn);
  } catch (err) {
    log.debug("makeDsn threw for DSN input", err);
    dsnComponents = undefined;
  }
  if (!dsnComponents) {
    throw new ValidationError(`Invalid DSN: ${dsn}`, "dsn");
  }
  return getEnvelopeEndpointWithUrlEncodedAuth(dsnComponents, undefined, {
    name: SENTRY_CLIENT,
    version: "dev",
  });
}

/**
 * Resolve the DSN to use for sending, in priority order:
 *   1. `--dsn` flag
 *   2. `SENTRY_DSN` environment variable
 *   3. Returns `undefined` (caller decides whether to auto-detect or error)
 */
export function resolveDsn(flags: DsnFlags): string | undefined {
  if (flags.dsn) {
    return flags.dsn.trim();
  }
  const envDsn = process.env.SENTRY_DSN;
  if (envDsn) {
    return envDsn.trim();
  }
  return;
}

/**
 * Resolve a DSN for envelope ingest: optional flag → `SENTRY_DSN` → project scan.
 *
 * Used by ingest commands such as `event send` and `monitor run`. Returns `undefined`
 * when none of those sources yield a DSN; callers decide whether to look up
 * a project key via the Web API or throw.
 *
 * @param flags - Optional DSN flag source, with `SENTRY_DSN` fallback.
 * @param cwd - Directory to scan for a project DSN when flag/env are absent.
 */
export async function resolveIngestDsn(
  flags: DsnFlags,
  cwd: string
): Promise<string | undefined> {
  const explicit = resolveDsn(flags);
  if (explicit) {
    return explicit;
  }

  const detected = await detectDsn(cwd);
  if (detected) {
    log.debug(`Using auto-detected DSN from ${detected.source}`);
    return detected.raw;
  }

  return;
}

/**
 * Require a DSN from `--dsn` or `SENTRY_DSN` only (no project scan).
 *
 * Prefer {@link resolveIngestDsn} for user-facing ingest commands. This
 * narrower helper remains for callers that must not touch the filesystem
 * (e.g. `bash-hook` generating a script).
 *
 * @param flags - DSN flag source (`--dsn`), with `SENTRY_DSN` fallback.
 * @param usageHint - Optional command-specific usage example shown in the
 *   error (e.g. `"sentry monitor run <slug> -- <command>"`).
 */
export function requireDsn(
  flags: DsnFlags,
  usageHint = "sentry bash-hook --dsn <your-dsn>"
): string {
  const dsn = resolveDsn(flags);
  if (dsn) {
    return dsn;
  }
  throw new ConfigError(
    "No DSN found. Provide one via --dsn <dsn> or set the SENTRY_DSN environment variable.",
    usageHint
  );
}

/**
 * Read a file's bytes, throwing a clean ValidationError on ENOENT or I/O errors.
 *
 * Centralises the file-reading error-handling pattern used by
 * `event send` (and previously by `send-envelope`).
 */
export async function readFileBytes(file: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ValidationError(`File not found: ${file}`, "path");
    }
    throw new ValidationError(
      `Cannot read file ${file}: ${(err as Error).message}`,
      "path"
    );
  }
}

/**
 * POST a serialized envelope to Sentry's ingest endpoint using DSN auth.
 *
 * No Bearer token is required — the DSN public key serves as authentication.
 * Throws ApiError on non-2xx responses.
 */
export async function sendEnvelopeRequest(
  dsn: string,
  body: string | Uint8Array
): Promise<void> {
  const url = buildEnvelopeUrl(dsn);

  const response = await fetch(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
    })
  );

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = (await response.json()) as Record<string, unknown>;
      if (typeof json.detail === "string") {
        detail = json.detail;
      }
    } catch (err) {
      log.debug("Non-JSON error body, using HTTP status message", err);
    }
    throw new ApiError(detail, response.status, detail, url);
  }
}
