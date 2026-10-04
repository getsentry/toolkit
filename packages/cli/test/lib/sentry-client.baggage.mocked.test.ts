/**
 * Tests for the baggage header ASCII guard in prepareHeaders() — CLI-3A8
 * regression coverage.
 *
 * Kept as a mocked sibling file because vi.mock() on @sentry/node-core/light
 * must precede all module imports to take effect.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock Setup — must precede all imports of the module under test

const { getTraceDataMock } = vi.hoisted(() => ({
  getTraceDataMock: vi.fn<() => Record<string, string>>(() => ({})),
}));

vi.mock("@sentry/node-core/light", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    getTraceData: getTraceDataMock,
  };
});

// Import AFTER mock setup
import { setAuthToken } from "../../src/lib/db/auth.js";
import {
  getSdkConfig,
  resetAuthenticatedFetch,
} from "../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("sentry-client-baggage-");

const REGION_URL = "https://us.sentry.io";

function getAuthenticatedFetch(): typeof fetch {
  return getSdkConfig(REGION_URL).fetch as typeof fetch;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await setAuthToken("test-token");
  resetAuthenticatedFetch();
  getTraceDataMock.mockReturnValue({});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAuthenticatedFetch();
  vi.clearAllMocks();
});

describe("prepareHeaders baggage guard", () => {
  test("omits the baggage header when it contains non-ASCII characters", async () => {
    // U+0131 is Turkish dotless ı, decimal 305 — the character seen in CLI-3A8.
    // It appears in a release name embedded in the sentry-release baggage field.
    const nonAsciiBaggage =
      "sentry-environment=production,sentry-release=my-rel\u0131ase";

    getTraceDataMock.mockReturnValue({
      "sentry-trace": "abc123",
      baggage: nonAsciiBaggage,
    });

    const capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mockFetch(async (_input, init) => {
      const headers = new Headers(init?.headers);
      headers.forEach((value, key) => {
        capturedHeaders[key] = value;
      });
      return new Response("{}", { status: 200 });
    });

    const authFetch = getAuthenticatedFetch();
    await authFetch(`${REGION_URL}/api/0/organizations/`, { method: "GET" });

    // sentry-trace is pure ASCII so it should be forwarded
    expect(capturedHeaders["sentry-trace"]).toBe("abc123");
    // baggage contains U+0131 — must be dropped to avoid a ByteString TypeError
    expect(capturedHeaders.baggage).toBeUndefined();
  });

  test("forwards the baggage header when it is valid ASCII", async () => {
    const asciiBaggage =
      "sentry-environment=production,sentry-release=1.2.3,sentry-public_key=abc";

    getTraceDataMock.mockReturnValue({
      "sentry-trace": "def456",
      baggage: asciiBaggage,
    });

    const capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mockFetch(async (_input, init) => {
      const headers = new Headers(init?.headers);
      headers.forEach((value, key) => {
        capturedHeaders[key] = value;
      });
      return new Response("{}", { status: 200 });
    });

    const authFetch = getAuthenticatedFetch();
    await authFetch(`${REGION_URL}/api/0/organizations/`, { method: "GET" });

    expect(capturedHeaders["sentry-trace"]).toBe("def456");
    expect(capturedHeaders.baggage).toBe(asciiBaggage);
  });

  test("omits the baggage header when it contains Latin-1 non-ASCII characters (> 0x7f, <= 0xff)", async () => {
    // Characters in the range 0x80-0xFF are valid Latin-1 but not ASCII.
    // undici (Node.js fetch) accepts them as ByteStrings (≤255) but they are
    // still outside the valid HTTP header-field-value range. Guard them too.
    const latin1Baggage = "sentry-release=v\xe9\xe0\xfc";

    getTraceDataMock.mockReturnValue({
      baggage: latin1Baggage,
    });

    const capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mockFetch(async (_input, init) => {
      const headers = new Headers(init?.headers);
      headers.forEach((value, key) => {
        capturedHeaders[key] = value;
      });
      return new Response("{}", { status: 200 });
    });

    const authFetch = getAuthenticatedFetch();
    await authFetch(`${REGION_URL}/api/0/organizations/`, { method: "GET" });

    expect(capturedHeaders.baggage).toBeUndefined();
  });
});
