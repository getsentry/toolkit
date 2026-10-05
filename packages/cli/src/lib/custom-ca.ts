/**
 * Custom CA certificate loading for corporate TLS proxies.
 *
 * Reads CA bundles from (in priority order):
 * 1. `sentry cli defaults ca-cert` (stored path in SQLite)
 * 2. `NODE_EXTRA_CA_CERTS` env var
 *
 * Returns a `tls` options object for Bun's `fetch()`. On the Node.js npm
 * distribution, Node natively honors `NODE_EXTRA_CA_CERTS` so the extra
 * `tls.ca` option is harmless (ignored by Node's fetch).
 *
 * Security model: When the CA source is an env var (not a stored default)
 * AND the target is SaaS (`*.sentry.io`), a one-time warning is logged.
 * `sentry cli defaults ca-cert` silences the warning — the user has
 * explicitly acknowledged the custom CA. See CLI-1K6 plan for the full
 * threat model discussion.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { rootCertificates } from "node:tls";

const _require = createRequire(import.meta.url);
import { getDefaultCaCert } from "./db/defaults.js";
import { getEnv } from "./env.js";
import { logger } from "./logger.js";
import { isSentrySaasUrl } from "./sentry-urls.js";

/**
 * Node 24+ exposes `tls.setDefaultCACertificates()` which modifies the
 * process-wide CA trust store — including for `fetch()`. On Node 22 the
 * function doesn't exist, and on Bun we use the per-request `tls.ca`
 * option instead.
 */
const setDefaultCACertificates: ((certs: string[]) => void) | undefined = (
  _require("node:tls") as {
    setDefaultCACertificates?: (certs: string[]) => void;
  }
).setDefaultCACertificates;

const log = logger.withTag("tls");

/** Where the loaded CA came from */
export type CaSource = "default" | "env" | "none";

/** Cached resolved state — computed once per process */
let resolved: { tls: { ca: string } } | undefined;
let resolvedSource: CaSource = "none";
let resolvedLabel = "";
let hasResolved = false;
let warnedSaas = false;

/**
 * Validate and read a CA certificate PEM file synchronously.
 * Returns `{ ok: true, content }` on success or `{ ok: false, reason }` on failure.
 *
 * Used by both the eager validation in `sentry cli defaults ca-cert` and
 * the lazy loading in `resolve()` — single source of truth for PEM validation.
 */
export function readCaCertFile(
  path: string
): { ok: true; content: string } | { ok: false; reason: string } {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return {
      ok: false,
      reason: `CA certificate file not found or not readable: ${path}`,
    };
  }
  if (!content.includes("-----BEGIN CERTIFICATE-----")) {
    return {
      ok: false,
      reason:
        "File does not contain PEM certificate data (expected -----BEGIN CERTIFICATE-----).",
    };
  }
  return { ok: true, content };
}

/**
 * Attempt to read a PEM file. Returns the file contents on success,
 * or undefined if the file doesn't exist or can't be read.
 * Never throws — a missing CA file shouldn't crash the CLI.
 */
function tryReadPem(path: string): string | undefined {
  const result = readCaCertFile(path);
  if (!result.ok) {
    log.warn(result.reason);
    return;
  }
  return result.content;
}

/**
 * On Node 24+, inject the custom CA into the process-wide TLS trust store
 * so Node's built-in `fetch()` (which ignores the Bun-specific `tls` option)
 * also uses the custom CAs. On Node 22 this is a no-op; those users rely
 * on `NODE_EXTRA_CA_CERTS` which Node handles natively.
 */
function injectIntoNodeTls(customPem: string): void {
  if (typeof setDefaultCACertificates !== "function") {
    return;
  }
  try {
    setDefaultCACertificates([...rootCertificates, customPem]);
    log.debug("Injected custom CA into Node.js TLS trust store");
  } catch (err) {
    log.debug(`Failed to set Node.js default CA certificates: ${err}`);
  }
}

/**
 * Resolve custom CA certificates. Runs once per process.
 *
 * Tries sources in priority order: stored default, NODE_EXTRA_CA_CERTS.
 * First readable PEM wins.
 */
function resolve(): void {
  if (hasResolved) {
    return;
  }
  hasResolved = true;

  // Build the source list. getDefaultCaCert() reads SQLite — if the DB
  // is broken, fall through to env var sources instead of aborting.
  let storedPath = "";
  try {
    storedPath = getDefaultCaCert() ?? "";
  } catch {
    log.debug("Failed to read stored ca-cert default from database");
  }

  const env = getEnv();
  const sources: { path: string; source: CaSource; label: string }[] = [
    { path: storedPath, source: "default", label: "stored default" },
    {
      path: env.NODE_EXTRA_CA_CERTS?.trim() ?? "",
      source: "env",
      label: "NODE_EXTRA_CA_CERTS",
    },
  ];

  for (const { path, source, label } of sources) {
    if (!path) {
      continue;
    }
    const pem = tryReadPem(path);
    if (pem) {
      // Bun's tls.ca replaces the default Mozilla CA bundle, so we must
      // concatenate the custom CA with the built-in root certificates
      // to preserve additive NODE_EXTRA_CA_CERTS semantics.
      const combined = [...rootCertificates, pem].join("\n");
      resolved = { tls: { ca: combined } };
      resolvedSource = source;
      resolvedLabel = label;
      log.debug(`Loaded CA certificates from ${label}: ${path}`);
      injectIntoNodeTls(pem);
      return;
    }
  }
}

/**
 * Get the `tls` options to spread into Bun's `fetch()` call.
 * Returns undefined when no custom CAs are configured.
 */
export function getCustomTlsOptions(): { tls: { ca: string } } | undefined {
  resolve();
  return resolved;
}

/** Get the source of the loaded CA certificates. */
export function getCustomCaSource(): CaSource {
  resolve();
  return resolvedSource;
}

/**
 * Log a one-time warning when env-sourced CAs are used for SaaS targets.
 *
 * Stored defaults (via `sentry cli defaults ca-cert`) are treated as
 * explicit user acknowledgment and do NOT trigger this warning.
 */
export function warnIfSaasWithEnvCa(targetUrl: string): void {
  resolve();
  if (warnedSaas || resolvedSource !== "env") {
    return;
  }
  if (!isSentrySaasUrl(targetUrl)) {
    return;
  }
  warnedSaas = true;

  log.warn(
    `Using custom CA certificates from ${resolvedLabel} for sentry.io connections.\n` +
      "  If you intended this (e.g. corporate proxy), silence this warning:\n" +
      "    sentry cli defaults ca-cert /path/to/cert.pem"
  );
}

/**
 * TLS certificate CA trust error patterns — errors that indicate the
 * server's certificate chain cannot be verified against known CAs.
 * These are fixable by providing a custom CA bundle.
 *
 * Excludes `CERT_HAS_EXPIRED` and `ERR_TLS_CERT_ALTNAME_INVALID` which
 * are not CA trust issues (expired cert / hostname mismatch) and would
 * produce misleading "add your CA cert" guidance.
 */
const TLS_ERROR_PATTERNS = [
  "unable to get local issuer certificate",
  "unable to verify the first certificate",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
] as const;

/**
 * Check if an error is a TLS certificate verification failure.
 * Walks `error.cause` to handle Node.js `fetch` which wraps TLS errors
 * in `TypeError: fetch failed` with the real error in `.cause`.
 */
export function isTlsCertError(error: unknown): boolean {
  return getTlsCertErrorMessage(error) !== undefined;
}

/**
 * Walk the error cause chain and return the message of the first error
 * that matches a TLS CA trust pattern, or undefined if none match.
 *
 * Node.js `fetch` wraps TLS errors in `TypeError: fetch failed` with
 * the real error in `.cause` — this finds the root TLS message so
 * callers display it instead of the generic wrapper.
 */
export function getTlsCertErrorMessage(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const msg = current.message;
    if (TLS_ERROR_PATTERNS.some((pattern) => msg.includes(pattern))) {
      return msg;
    }
    current = current.cause;
  }
  return;
}

/**
 * Build a user-friendly error detail for TLS certificate failures.
 * Walks `error.cause` to extract the root TLS error (Node.js wraps
 * TLS errors in `TypeError: fetch failed`).
 *
 * When custom CAs are already loaded, the message says "still failed"
 * so the user knows to check their bundle — not re-run the same setup.
 */
export function buildTlsErrorDetail(error: Error): string {
  const cause = getTlsCertErrorMessage(error) ?? error.message;
  const hasCustomCa = getCustomCaSource() !== "none";

  if (hasCustomCa) {
    return (
      `TLS certificate verification failed: ${cause}\n\n` +
      "  Custom CA certificates are loaded but verification still failed.\n" +
      "  The certificate file may not contain the correct CA for this server.\n\n" +
      "  Check that your CA bundle includes the certificate authority used by\n" +
      "  your network proxy or Sentry instance."
    );
  }

  return (
    `TLS certificate verification failed: ${cause}\n\n` +
    "  This usually means your network uses a TLS-intercepting proxy\n" +
    "  (corporate firewall, VPN) with a private certificate authority.\n\n" +
    "  To fix this, point the CLI to your CA certificate bundle:\n" +
    "    sentry cli defaults ca-cert /path/to/corporate-ca.pem\n\n" +
    "  Or set the NODE_EXTRA_CA_CERTS environment variable:\n" +
    "    export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem"
  );
}

/**
 * Get the combined CA certificate PEM string for Node.js `http.request()`.
 * Returns undefined when no custom CAs are configured.
 *
 * Unlike {@link getCustomTlsOptions} (which returns Bun's `{ tls: { ca } }` shape),
 * this returns the raw PEM string suitable for Node's `https.RequestOptions.ca`
 * and the Sentry SDK's `NodeTransportOptions.caCerts`.
 */
export function getCustomCaCerts(): string | undefined {
  resolve();
  return resolved?.tls.ca;
}

/**
 * Drop-in replacement for `fetch()` that injects custom CA certificates
 * when configured. All non-authenticated fetch call sites should use this
 * instead of bare `fetch()`.
 *
 * Authenticated API calls go through `fetchWithTimeout()` in sentry-client.ts
 * which already applies TLS options directly alongside the SaaS warning.
 */
export function customFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const tlsOpts = getCustomTlsOptions();
  if (!tlsOpts) {
    return fetch(input, init);
  }
  return fetch(input, { ...init, ...tlsOpts });
}

/**
 * Reset all cached state. Exported for test isolation only.
 * @internal
 */
export function __resetForTests(): void {
  resolved = undefined;
  resolvedSource = "none";
  resolvedLabel = "";
  hasResolved = false;
  warnedSaas = false;
}
