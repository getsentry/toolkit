/**
 * Tests for custom CA certificate loading and TLS error detection.
 *
 * isTlsCertError is a pure function tested thoroughly here.
 * CA loading tests use temp files and env sandboxing.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  __resetForTests,
  customFetch,
  getCustomCaCerts,
  getCustomCaSource,
  getCustomTlsOptions,
  getTlsCertErrorMessage,
  isTlsCertError,
  warnIfSaasWithEnvCa,
} from "../../src/lib/custom-ca.js";
import { setDefaultCaCert } from "../../src/lib/db/defaults.js";
import { useTestConfigDir } from "../helpers.js";

// ---------------------------------------------------------------------------
// isTlsCertError — pure detection tests
// ---------------------------------------------------------------------------

describe("isTlsCertError", () => {
  test("detects 'unable to get local issuer certificate'", () => {
    expect(
      isTlsCertError(new Error("unable to get local issuer certificate"))
    ).toBe(true);
  });

  test("detects 'unable to verify the first certificate'", () => {
    expect(
      isTlsCertError(new Error("unable to verify the first certificate"))
    ).toBe(true);
  });

  test("detects UNABLE_TO_VERIFY_LEAF_SIGNATURE", () => {
    expect(isTlsCertError(new Error("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toBe(
      true
    );
  });

  test("does NOT detect CERT_HAS_EXPIRED (not a CA trust issue)", () => {
    expect(isTlsCertError(new Error("CERT_HAS_EXPIRED"))).toBe(false);
  });

  test("does NOT detect ERR_TLS_CERT_ALTNAME_INVALID (not a CA trust issue)", () => {
    expect(isTlsCertError(new Error("ERR_TLS_CERT_ALTNAME_INVALID"))).toBe(
      false
    );
  });

  test("detects DEPTH_ZERO_SELF_SIGNED_CERT", () => {
    expect(isTlsCertError(new Error("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe(true);
  });

  test("detects SELF_SIGNED_CERT_IN_CHAIN", () => {
    expect(isTlsCertError(new Error("SELF_SIGNED_CERT_IN_CHAIN"))).toBe(true);
  });

  test("detects pattern within larger message", () => {
    expect(
      isTlsCertError(
        new Error(
          "request to https://sentry.io failed, reason: unable to get local issuer certificate"
        )
      )
    ).toBe(true);
  });

  test("returns false for non-TLS errors", () => {
    expect(isTlsCertError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isTlsCertError(new Error("fetch failed"))).toBe(false);
    expect(isTlsCertError(new Error("timeout"))).toBe(false);
    expect(isTlsCertError(new Error("network error"))).toBe(false);
  });

  test("getTlsCertErrorMessage extracts root cause from wrapped error", () => {
    const cause = new Error("unable to get local issuer certificate");
    const wrapper = new TypeError("fetch failed");
    wrapper.cause = cause;
    expect(getTlsCertErrorMessage(wrapper)).toBe(
      "unable to get local issuer certificate"
    );
  });

  test("getTlsCertErrorMessage returns undefined for non-TLS errors", () => {
    expect(getTlsCertErrorMessage(new Error("ECONNREFUSED"))).toBeUndefined();
  });

  test("detects TLS error wrapped in error.cause (Node.js fetch pattern)", () => {
    const cause = new Error("unable to get local issuer certificate");
    const wrapper = new TypeError("fetch failed");
    wrapper.cause = cause;
    expect(isTlsCertError(wrapper)).toBe(true);
  });

  test("detects deeply nested error.cause chain", () => {
    const root = new Error("SELF_SIGNED_CERT_IN_CHAIN");
    const mid = new Error("request failed");
    mid.cause = root;
    const outer = new TypeError("fetch failed");
    outer.cause = mid;
    expect(isTlsCertError(outer)).toBe(true);
  });

  test("returns false for non-TLS error.cause", () => {
    const cause = new Error("ECONNREFUSED");
    const wrapper = new TypeError("fetch failed");
    wrapper.cause = cause;
    expect(isTlsCertError(wrapper)).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isTlsCertError("unable to get local issuer certificate")).toBe(
      false
    );
    expect(isTlsCertError(null)).toBe(false);
    expect(isTlsCertError(undefined)).toBe(false);
    expect(isTlsCertError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CA loading — requires DB + env sandboxing
// ---------------------------------------------------------------------------

describe("custom CA loading", () => {
  const getConfigDir = useTestConfigDir("custom-ca-");
  const CERT_PEM =
    "-----BEGIN CERTIFICATE-----\nMIIBxyz...\n-----END CERTIFICATE-----\n";

  let savedNodeExtra: string | undefined;

  beforeEach(() => {
    __resetForTests();
    savedNodeExtra = process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NODE_EXTRA_CA_CERTS;
  });

  afterEach(() => {
    if (savedNodeExtra !== undefined) {
      process.env.NODE_EXTRA_CA_CERTS = savedNodeExtra;
    } else {
      delete process.env.NODE_EXTRA_CA_CERTS;
    }
  });

  test("returns undefined when no CAs configured", () => {
    const result = getCustomTlsOptions();
    expect(result).toBeUndefined();
    expect(getCustomCaSource()).toBe("none");
  });

  test("loads CA from stored default (highest priority)", () => {
    const certPath = join(getConfigDir(), "ca.pem");
    writeFileSync(certPath, CERT_PEM);
    setDefaultCaCert(certPath);

    const result = getCustomTlsOptions();
    expect(result).toBeDefined();
    // Custom CA is concatenated with root certificates (additive semantics)
    expect(result?.tls.ca).toContain(CERT_PEM);
    expect(result?.tls.ca).toContain("-----BEGIN CERTIFICATE-----");
    expect(getCustomCaSource()).toBe("default");
  });

  test("loads CA from NODE_EXTRA_CA_CERTS", () => {
    const certPath = join(getConfigDir(), "extra-ca.pem");
    writeFileSync(certPath, CERT_PEM);
    process.env.NODE_EXTRA_CA_CERTS = certPath;

    const result = getCustomTlsOptions();
    expect(result).toBeDefined();
    expect(result?.tls.ca).toContain(CERT_PEM);
    expect(getCustomCaSource()).toBe("env");
  });

  test("stored default takes priority over env vars", () => {
    const defaultPath = join(getConfigDir(), "default-ca.pem");
    const envPath = join(getConfigDir(), "env-ca.pem");
    const ENV_PEM =
      "-----BEGIN CERTIFICATE-----\nDIFFERENT\n-----END CERTIFICATE-----\n";
    writeFileSync(defaultPath, CERT_PEM);
    writeFileSync(envPath, ENV_PEM);
    setDefaultCaCert(defaultPath);
    process.env.NODE_EXTRA_CA_CERTS = envPath;

    const result = getCustomTlsOptions();
    expect(result?.tls.ca).toContain(CERT_PEM);
    expect(result?.tls.ca).not.toContain("DIFFERENT");
    expect(getCustomCaSource()).toBe("default");
  });

  test("returns undefined when cert file does not exist", () => {
    process.env.NODE_EXTRA_CA_CERTS = "/nonexistent/path/ca.pem";

    const result = getCustomTlsOptions();
    expect(result).toBeUndefined();
    expect(getCustomCaSource()).toBe("none");
  });

  test("returns undefined when cert file is not valid PEM", () => {
    const certPath = join(getConfigDir(), "not-pem.txt");
    writeFileSync(certPath, "this is not a PEM file");
    process.env.NODE_EXTRA_CA_CERTS = certPath;

    const result = getCustomTlsOptions();
    expect(result).toBeUndefined();
    expect(getCustomCaSource()).toBe("none");
  });

  test("caches result across calls", () => {
    const certPath = join(getConfigDir(), "cached.pem");
    writeFileSync(certPath, CERT_PEM);
    process.env.NODE_EXTRA_CA_CERTS = certPath;

    const first = getCustomTlsOptions();
    // Even if env var changes, cached result stays
    process.env.NODE_EXTRA_CA_CERTS = "/different/path";
    const second = getCustomTlsOptions();
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// SaaS warning
// ---------------------------------------------------------------------------

describe("warnIfSaasWithEnvCa", () => {
  const getConfigDir = useTestConfigDir("saas-warn-");
  const CERT_PEM =
    "-----BEGIN CERTIFICATE-----\nMIIBxyz...\n-----END CERTIFICATE-----\n";

  let savedNodeExtra: string | undefined;

  beforeEach(() => {
    __resetForTests();
    savedNodeExtra = process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NODE_EXTRA_CA_CERTS;
  });

  afterEach(() => {
    if (savedNodeExtra !== undefined) {
      process.env.NODE_EXTRA_CA_CERTS = savedNodeExtra;
    } else {
      delete process.env.NODE_EXTRA_CA_CERTS;
    }
  });

  test("does not warn for stored default CAs targeting SaaS", () => {
    const certPath = join(getConfigDir(), "ca.pem");
    writeFileSync(certPath, CERT_PEM);
    setDefaultCaCert(certPath);
    getCustomTlsOptions();

    // Should not throw or warn — source is "default" not "env"
    warnIfSaasWithEnvCa("https://us.sentry.io/api/0/organizations/");
    expect(getCustomCaSource()).toBe("default");
  });

  test("does not warn for env CAs targeting self-hosted", () => {
    const certPath = join(getConfigDir(), "ca.pem");
    writeFileSync(certPath, CERT_PEM);
    process.env.NODE_EXTRA_CA_CERTS = certPath;
    getCustomTlsOptions();

    // Self-hosted URL — no warning
    warnIfSaasWithEnvCa("https://sentry.example.com/api/0/");
    expect(getCustomCaSource()).toBe("env");
  });
});

// ---------------------------------------------------------------------------
// getCustomCaCerts — raw PEM string for Node http.request()
// ---------------------------------------------------------------------------

describe("getCustomCaCerts", () => {
  const getConfigDir = useTestConfigDir("ca-certs-");
  const CERT_PEM =
    "-----BEGIN CERTIFICATE-----\nMIIBxyz...\n-----END CERTIFICATE-----\n";

  let savedNodeExtra: string | undefined;

  beforeEach(() => {
    __resetForTests();
    savedNodeExtra = process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NODE_EXTRA_CA_CERTS;
  });

  afterEach(() => {
    if (savedNodeExtra !== undefined) {
      process.env.NODE_EXTRA_CA_CERTS = savedNodeExtra;
    } else {
      delete process.env.NODE_EXTRA_CA_CERTS;
    }
  });

  test("returns undefined when no CAs configured", () => {
    expect(getCustomCaCerts()).toBeUndefined();
  });

  test("returns PEM string when CA is loaded", () => {
    const certPath = join(getConfigDir(), "ca.pem");
    writeFileSync(certPath, CERT_PEM);
    process.env.NODE_EXTRA_CA_CERTS = certPath;

    const caCerts = getCustomCaCerts();
    expect(caCerts).toBeDefined();
    expect(caCerts).toContain(CERT_PEM);
  });

  test("returns same value as getCustomTlsOptions().tls.ca", () => {
    const certPath = join(getConfigDir(), "ca.pem");
    writeFileSync(certPath, CERT_PEM);
    process.env.NODE_EXTRA_CA_CERTS = certPath;

    const caCerts = getCustomCaCerts();
    const tlsOpts = getCustomTlsOptions();
    expect(caCerts).toBe(tlsOpts?.tls.ca);
  });
});

// ---------------------------------------------------------------------------
// customFetch — TLS-aware fetch wrapper
// ---------------------------------------------------------------------------

describe("customFetch", () => {
  const getConfigDir = useTestConfigDir("custom-fetch-");
  const CERT_PEM =
    "-----BEGIN CERTIFICATE-----\nMIIBxyz...\n-----END CERTIFICATE-----\n";

  let savedNodeExtra: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    __resetForTests();
    savedNodeExtra = process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NODE_EXTRA_CA_CERTS;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedNodeExtra !== undefined) {
      process.env.NODE_EXTRA_CA_CERTS = savedNodeExtra;
    } else {
      delete process.env.NODE_EXTRA_CA_CERTS;
    }
  });

  test("calls fetch without tls option when no custom CA", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    await customFetch("https://example.com", { headers: { "X-Test": "1" } });
    expect(capturedInit).toBeDefined();
    expect(capturedInit?.headers).toEqual({ "X-Test": "1" });
    expect((capturedInit as Record<string, unknown>).tls).toBeUndefined();
  });

  test("spreads tls options when custom CA is loaded", async () => {
    const certPath = join(getConfigDir(), "ca.pem");
    writeFileSync(certPath, CERT_PEM);
    process.env.NODE_EXTRA_CA_CERTS = certPath;

    let capturedInit: Record<string, unknown> | undefined;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      capturedInit = init as Record<string, unknown>;
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    await customFetch("https://example.com", { headers: { "X-Test": "1" } });
    expect(capturedInit).toBeDefined();
    expect(capturedInit?.tls).toBeDefined();
    expect((capturedInit?.tls as { ca: string }).ca).toContain(CERT_PEM);
  });

  test("preserves caller init options alongside tls", async () => {
    const certPath = join(getConfigDir(), "ca.pem");
    writeFileSync(certPath, CERT_PEM);
    process.env.NODE_EXTRA_CA_CERTS = certPath;

    let capturedInit: Record<string, unknown> | undefined;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      capturedInit = init as Record<string, unknown>;
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;

    await customFetch("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(capturedInit?.tls).toBeDefined();
  });
});
