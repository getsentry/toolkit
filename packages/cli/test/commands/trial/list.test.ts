/**
 * Trial List Command Tests
 *
 * Tests for the trial list command in src/commands/trial/list.ts.
 * Uses spyOn pattern to mock API client and resolve-target.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { listCommand } from "../../../src/commands/trial/list.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import type {
  CustomerTrialInfo,
  ProductTrial,
} from "../../../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(cwd = "/tmp") {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd,
    },
    stdoutWrite,
    stderrWrite,
  };
}

/** Helper to create a date string N days from now */
function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0]!;
}

/**
 * Build a CustomerTrialInfo response with product trials and optional plan trial fields.
 */
function makeCustomerInfo(
  overrides: Partial<CustomerTrialInfo> & {
    productTrials?: ProductTrial[] | null;
  } = {}
): CustomerTrialInfo {
  return {
    productTrials: [],
    canTrial: false,
    isTrial: false,
    trialEnd: null,
    planDetails: { name: "Developer", trialPlan: "am3_t" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const AVAILABLE_TRIAL: ProductTrial = {
  category: "seerUsers",
  startDate: null,
  endDate: null,
  reasonCode: 0,
  isStarted: false,
  lengthDays: 14,
};

const ACTIVE_TRIAL: ProductTrial = {
  category: "replays",
  startDate: "2025-06-01",
  endDate: daysFromNow(7),
  reasonCode: 0,
  isStarted: true,
  lengthDays: 14,
};

const EXPIRED_TRIAL: ProductTrial = {
  category: "transactions",
  startDate: "2025-01-01",
  endDate: "2025-01-15",
  reasonCode: 0,
  isStarted: true,
  lengthDays: 14,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trial list command", () => {
  let getCustomerTrialInfoSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getCustomerTrialInfoSpy = vi.spyOn(apiClient, "getCustomerTrialInfo");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    getCustomerTrialInfoSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("outputs JSON array of product trials with --json", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [AVAILABLE_TRIAL, ACTIVE_TRIAL],
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("seer");
    expect(parsed[0].category).toBe("seerUsers");
    expect(parsed[0].status).toBe("available");
    expect(parsed[1].name).toBe("replays");
    expect(parsed[1].status).toBe("active");
  });

  test("excludes displayName from JSON output", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ productTrials: [AVAILABLE_TRIAL] })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed[0]).not.toHaveProperty("displayName");
  });

  test("outputs human-readable table with column headers", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [AVAILABLE_TRIAL, ACTIVE_TRIAL, EXPIRED_TRIAL],
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("TRIAL");
    expect(output).toContain("STATUS");
    expect(output).toContain("DAYS LEFT");
    // Human table shows displayName with CLI name in parentheses
    expect(output).toContain("Seer");
    expect(output).toContain("(seer)");
    expect(output).toContain("Session Replay");
    expect(output).toContain("(replays)");
    expect(output).toContain("Performance");
    expect(output).toContain("(performance)");
  });

  test("shows empty state message when no trials and no plan trial", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ productTrials: [], canTrial: false })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No trials found");
  });

  test("outputs empty JSON array when no trials and no plan trial", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ productTrials: [], canTrial: false })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(output)).toEqual([]);
  });

  test("uses org from positional argument", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ productTrials: [AVAILABLE_TRIAL] })
    );

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, "my-org");

    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: "my-org" })
    );
    expect(getCustomerTrialInfoSpy).toHaveBeenCalledWith("my-org");
  });

  test("throws ContextError when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await listCommand.loader();

    await expect(
      func.call(context, { json: false }, undefined)
    ).rejects.toThrow("organization");
  });

  test("includes hint about starting trial when available product trials exist", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ productTrials: [AVAILABLE_TRIAL] })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("sentry trial start");
  });

  // -----------------------------------------------------------------------
  // Plan trial tests
  // -----------------------------------------------------------------------

  test("shows plan trial entry when canTrial is true", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [],
        canTrial: true,
        planDetails: { name: "Developer", trialPlan: "am3_t" },
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("plan");
    expect(parsed[0].category).toBe("plan");
    expect(parsed[0].status).toBe("available");
  });

  test("plan trial entry shows upgrade path in displayName", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [],
        canTrial: true,
        planDetails: { name: "Developer", trialPlan: "am3_t" },
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Developer -> Business");
  });

  test("shows active plan trial with days remaining", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [],
        canTrial: false,
        isTrial: true,
        trialEnd: daysFromNow(10),
        planDetails: { name: "Business", trialPlan: null },
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("plan");
    expect(parsed[0].status).toBe("active");
    expect(parsed[0].daysRemaining).toBeGreaterThanOrEqual(9);
    expect(parsed[0].daysRemaining).toBeLessThanOrEqual(11);
  });

  test("plan trial appears before product trials", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [AVAILABLE_TRIAL],
        canTrial: true,
        planDetails: { name: "Developer", trialPlan: "am3_t" },
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("plan");
    expect(parsed[1].name).toBe("seer");
  });

  test("includes start command hint when plan trial is available", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [],
        canTrial: true,
        planDetails: { name: "Developer", trialPlan: "am3_t" },
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("sentry trial start plan");
  });

  test("handles null productTrials from API", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: null,
        canTrial: true,
        planDetails: { name: "Developer", trialPlan: "am3_t" },
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    // Should still show the plan trial entry
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("plan");
  });

  test("no plan entry when canTrial is false and isTrial is false", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [EXPIRED_TRIAL],
        canTrial: false,
        isTrial: false,
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("performance");
  });

  test("uses friendly names for known categories", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [
          { ...EXPIRED_TRIAL, category: "monitorSeats" },
          { ...EXPIRED_TRIAL, category: "profileDurationUI" },
        ],
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed[0].name).toBe("monitors");
    expect(parsed[1].name).toBe("profiling");
  });

  test("deduplicates categories that map to the same trial name", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [
          { ...EXPIRED_TRIAL, category: "profileDuration" },
          { ...EXPIRED_TRIAL, category: "profileDurationUI" },
        ],
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    // Should show only one "profiling" entry, not two
    const profilingEntries = parsed.filter(
      (e: { name: string }) => e.name === "profiling"
    );
    expect(profilingEntries).toHaveLength(1);
  });

  test("dedup prefers active over expired for same trial name", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [
          { ...EXPIRED_TRIAL, category: "profileDuration" },
          {
            ...ACTIVE_TRIAL,
            category: "profileDurationUI",
            endDate: daysFromNow(5),
          },
        ],
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: true }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    const profiling = parsed.find(
      (e: { name: string }) => e.name === "profiling"
    );
    expect(profiling.status).toBe("active");
  });

  test("dedup in human output shows single row for duplicated categories", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        productTrials: [
          { ...EXPIRED_TRIAL, category: "profileDuration" },
          { ...EXPIRED_TRIAL, category: "profileDurationUI" },
        ],
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { json: false }, undefined);

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    // Count occurrences of "Profiling" — should be exactly one row
    const matches = output.match(/Profiling/g);
    expect(matches).toHaveLength(1);
  });
});
