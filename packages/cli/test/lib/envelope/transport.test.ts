/**
 * Tests for the DSN-based envelope transport.
 *
 * Core invariants:
 * - URL is built from DSN components (host + projectId)
 * - Auth is injected as query params (sentry_key, sentry_version)
 * - Content-Type is always application/x-sentry-envelope
 * - Non-2xx responses throw ApiError
 * - Both string and Uint8Array bodies are supported
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn
import * as dsnIndex from "../../../src/lib/dsn/index.js";
import {
  buildEnvelopeUrl,
  resolveDsn,
  resolveIngestDsn,
  sendEnvelopeRequest,
} from "../../../src/lib/envelope/transport.js";
import { ApiError, ValidationError } from "../../../src/lib/errors.js";
import { useEnvSandbox } from "../../helpers.js";

const SAAS_DSN = "https://abc123@o1169445.ingest.us.sentry.io/4505229541441536";
const SELF_HOSTED_DSN = "https://pubkey99@sentry.mycompany.com/7";

useEnvSandbox(["SENTRY_DSN"]);

describe("buildEnvelopeUrl", () => {
  test("SaaS DSN → correct ingest URL with auth params", () => {
    const url = buildEnvelopeUrl(SAAS_DSN);
    expect(url).toContain("/api/4505229541441536/envelope/");
    expect(url).toContain("sentry_key=abc123");
    expect(url).toContain("sentry_version=7");
    expect(url.startsWith("https://")).toBe(true);
  });

  test("self-hosted DSN → correct ingest URL", () => {
    const url = buildEnvelopeUrl(SELF_HOSTED_DSN);
    expect(url).toContain("sentry.mycompany.com");
    expect(url).toContain("/api/7/envelope/");
    expect(url).toContain("sentry_key=pubkey99");
  });

  test("invalid DSN → throws ValidationError", () => {
    expect(() => buildEnvelopeUrl("not-a-dsn")).toThrow(ValidationError);
  });

  test("sentry_client does not have doubled version suffix", () => {
    // SENTRY_CLIENT must be the bare name ('sentry-cli'), not 'sentry-cli/dev',
    // because getEnvelopeEndpointWithUrlEncodedAuth appends /<version> internally.
    const url = buildEnvelopeUrl(SAAS_DSN);
    expect(url).not.toContain("sentry-cli%2Fdev%2Fdev");
    expect(decodeURIComponent(url)).toContain("sentry_client=sentry-cli/");
  });
});

describe("resolveDsn", () => {
  test("explicit --dsn flag takes priority over env", () => {
    process.env.SENTRY_DSN = SELF_HOSTED_DSN;
    const result = resolveDsn({ dsn: SAAS_DSN });
    expect(result).toBe(SAAS_DSN);
  });

  test("SENTRY_DSN env var used when no flag", () => {
    process.env.SENTRY_DSN = SAAS_DSN;
    const result = resolveDsn({ dsn: undefined });
    expect(result).toBe(SAAS_DSN);
  });

  test("returns undefined when neither flag nor env set", () => {
    delete process.env.SENTRY_DSN;
    const result = resolveDsn({ dsn: undefined });
    expect(result).toBeUndefined();
  });

  test("trims whitespace from --dsn flag", () => {
    const result = resolveDsn({ dsn: `  ${SAAS_DSN}  ` });
    expect(result).toBe(SAAS_DSN);
  });

  test("trims whitespace from SENTRY_DSN env var", () => {
    process.env.SENTRY_DSN = `\n${SAAS_DSN}\n`;
    const result = resolveDsn({ dsn: undefined });
    expect(result).toBe(SAAS_DSN);
  });
});

describe("resolveIngestDsn", () => {
  let detectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    detectSpy = vi.spyOn(dsnIndex, "detectDsn").mockResolvedValue(null);
  });

  afterEach(() => {
    detectSpy.mockRestore();
  });

  test("returns flag/env DSN without scanning", async () => {
    process.env.SENTRY_DSN = SAAS_DSN;
    await expect(resolveIngestDsn({}, "/tmp")).resolves.toBe(SAAS_DSN);
    expect(detectSpy).not.toHaveBeenCalled();
  });

  test("returns a project-scanned DSN when explicit sources are absent", async () => {
    detectSpy.mockResolvedValue({
      raw: SAAS_DSN,
      protocol: "https",
      publicKey: "abc123",
      host: "o1169445.ingest.us.sentry.io",
      projectId: "4505229541441536",
      source: "env_file",
    });

    await expect(resolveIngestDsn({}, "/tmp/project")).resolves.toBe(SAAS_DSN);
    expect(detectSpy).toHaveBeenCalledWith("/tmp/project");
  });
});

describe("sendEnvelopeRequest", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("POSTs with correct Content-Type header", async () => {
    let capturedRequest: Request | undefined;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedRequest = input as Request;
      return new Response("{}", { status: 200 });
    };

    await sendEnvelopeRequest(
      SAAS_DSN,
      '{"event_id":"abc"}\n{"type":"event","length":2}\n{}'
    );

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.method).toBe("POST");
    expect(capturedRequest!.headers.get("Content-Type")).toBe(
      "application/x-sentry-envelope"
    );
  });

  test("URL contains sentry_key and sentry_version", async () => {
    let capturedUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = (input as Request).url;
      return new Response("{}", { status: 200 });
    };

    await sendEnvelopeRequest(SAAS_DSN, "body");

    expect(capturedUrl).toContain("sentry_key=abc123");
    expect(capturedUrl).toContain("sentry_version=7");
  });

  test("accepts Uint8Array body", async () => {
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    // should not throw
    await expect(
      sendEnvelopeRequest(SAAS_DSN, new TextEncoder().encode("bytes"))
    ).resolves.toBeUndefined();
  });

  test("non-2xx response throws ApiError", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "invalid DSN" }), { status: 403 });

    await expect(sendEnvelopeRequest(SAAS_DSN, "body")).rejects.toBeInstanceOf(
      ApiError
    );
  });

  test("400 response includes error detail in message", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "bad envelope" }), {
        status: 400,
      });

    const err = await sendEnvelopeRequest(SAAS_DSN, "body").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("bad envelope");
  });
});
