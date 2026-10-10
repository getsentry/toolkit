/**
 * Status Command Tests
 *
 * Tests for the showCommand func() in src/commands/status/show.ts.
 * Mocks globalThis.fetch to return canned Statuspage summary payloads and
 * asserts on both human and --json output.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { showCommand } from "../../../src/commands/status/show.js";

type ShowFlags = {
  readonly json: boolean;
  readonly url: string;
};
type ShowFunc = (this: unknown, flags: ShowFlags) => Promise<void>;

/** Store original fetch for restoration. */
let originalFetch: typeof globalThis.fetch;

function mockFetch(payload: unknown, ok = true, status = 200): void {
  globalThis.fetch = (async () =>
    ({
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }) as unknown as Response) as typeof globalThis.fetch;
}

/** Create a mock Stricli context with stdout capture. */
function createContext() {
  const stdoutChunks: string[] = [];
  return {
    context: {
      stdout: {
        write: vi.fn((s: string) => {
          stdoutChunks.push(s);
        }),
      },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    getOutput: () => stdoutChunks.join(""),
  };
}

const OPERATIONAL_SUMMARY = {
  page: { url: "https://status.sentry.io" },
  status: { indicator: "none", description: "All Systems Operational" },
  components: [
    { name: "Dashboard", status: "operational", group: false },
    { name: "Group Header", status: "operational", group: true },
  ],
  incidents: [],
};

const OUTAGE_SUMMARY = {
  page: { url: "https://status.sentry.io" },
  status: { indicator: "major", description: "Major Service Outage" },
  components: [
    { name: "Dashboard", status: "partial_outage", group: false },
    { name: "Slack", status: "operational", group: false },
  ],
  incidents: [
    {
      name: "sentry.io is not available",
      status: "investigating",
      impact: "major",
      shortlink: "https://stspg.io/abc123",
    },
  ],
};

describe("showCommand.func", () => {
  let func: ShowFunc;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    func = (await showCommand.loader()) as unknown as ShowFunc;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const humanFlags: ShowFlags = {
    json: false,
    url: "https://status.sentry.io",
  };
  const jsonFlags: ShowFlags = { json: true, url: "https://status.sentry.io" };

  test("renders operational status and drops group headers", async () => {
    mockFetch(OPERATIONAL_SUMMARY);
    const { context, getOutput } = createContext();

    await func.call(context, humanFlags);

    const out = getOutput();
    expect(out).toContain("All Systems Operational");
    expect(out).toContain("Dashboard");
    // Group entries are filtered out of the component list.
    expect(out).not.toContain("Group Header");
  });

  test("renders incidents and impacted components during an outage", async () => {
    mockFetch(OUTAGE_SUMMARY);
    const { context, getOutput } = createContext();

    await func.call(context, humanFlags);

    const out = getOutput();
    expect(out).toContain("Major Service Outage");
    expect(out).toContain("Active Incidents");
    expect(out).toContain("sentry.io is not available");
    expect(out).toContain("Dashboard");
    // Operational components are hidden when there is at least one impacted one.
    expect(out).not.toContain("Slack");
  });

  test("emits structured JSON with --json", async () => {
    mockFetch(OUTAGE_SUMMARY);
    const { context, getOutput } = createContext();

    await func.call(context, jsonFlags);

    const parsed = JSON.parse(getOutput());
    expect(parsed.indicator).toBe("major");
    expect(parsed.description).toBe("Major Service Outage");
    expect(parsed.components).toHaveLength(2);
    expect(parsed.incidents[0].name).toBe("sentry.io is not available");
  });

  test("falls back to a self-hosted health probe when summary.json is unavailable", async () => {
    // Both the summary probe and the health fallback return non-2xx, so the
    // command degrades to a synthetic "major" status rather than throwing.
    mockFetch({}, false, 503);
    const { context, getOutput } = createContext();

    await func.call(context, humanFlags);

    const out = getOutput();
    expect(out).toContain("●");
  });
});
