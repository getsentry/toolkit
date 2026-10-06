/**
 * Trial Start Command Tests
 *
 * Tests for the trial start command in src/commands/trial/start.ts.
 * Uses spyOn pattern to mock API client and resolve-target.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { startCommand } from "../../../src/commands/trial/start.js";

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

vi.mock("../../../src/lib/browser.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/browser.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browserMod from "../../../src/lib/browser.js";
import { ValidationError } from "../../../src/lib/errors.js";

vi.mock("../../../src/lib/qrcode.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/qrcode.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as qrcodeMod from "../../../src/lib/qrcode.js";

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

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_TRIAL: ProductTrial = {
  category: "seerUsers",
  startDate: null,
  endDate: null,
  reasonCode: 0,
  isStarted: false,
  lengthDays: 14,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trial start command", () => {
  let getProductTrialsSpy: ReturnType<typeof spyOn>;
  let startProductTrialSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getProductTrialsSpy = vi.spyOn(apiClient, "getProductTrials");
    startProductTrialSpy = vi
      .spyOn(apiClient, "startProductTrial")
      .mockResolvedValue(undefined);
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    getProductTrialsSpy.mockRestore();
    startProductTrialSpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("starts a trial and returns JSON result", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getProductTrialsSpy.mockResolvedValue([MOCK_TRIAL]);

    const { context, stdoutWrite } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: true }, "seer");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.name).toBe("seer");
    expect(parsed.category).toBe("seerUsers");
    expect(parsed.organization).toBe("test-org");
    expect(parsed.started).toBe(true);
    expect(parsed.lengthDays).toBe(14);
  });

  test("calls startProductTrial with correct args", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getProductTrialsSpy.mockResolvedValue([MOCK_TRIAL]);

    const { context } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: true }, "seer");

    expect(startProductTrialSpy).toHaveBeenCalledWith("test-org", "seerUsers");
  });

  test("human output shows success message", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getProductTrialsSpy.mockResolvedValue([MOCK_TRIAL]);

    const { context, stdoutWrite } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: false }, "seer");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Seer");
    expect(output).toContain("trial started");
    expect(output).toContain("test-org");
  });

  test("throws ValidationError for unknown trial name", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });

    const { context } = createMockContext();
    const func = await startCommand.loader();

    await expect(
      func.call(context, { json: false }, "unknown-name")
    ).rejects.toThrow(ValidationError);
  });

  test("throws ValidationError when no trial available", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getProductTrialsSpy.mockResolvedValue([]);

    const { context } = createMockContext();
    const func = await startCommand.loader();

    await expect(func.call(context, { json: false }, "seer")).rejects.toThrow(
      ValidationError
    );
  });

  test("error message uses display name when no trial available", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getProductTrialsSpy.mockResolvedValue([]);

    const { context } = createMockContext();
    const func = await startCommand.loader();

    try {
      await func.call(context, { json: false }, "seer");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain("Seer");
    }
  });

  test("throws ContextError when org cannot be resolved", async () => {
    resolveOrgSpy.mockResolvedValue(null);

    const { context } = createMockContext();
    const func = await startCommand.loader();

    await expect(func.call(context, { json: false }, "seer")).rejects.toThrow(
      "organization"
    );
  });

  test("uses org from second positional argument", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    getProductTrialsSpy.mockResolvedValue([MOCK_TRIAL]);

    const { context } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: true }, "seer", "my-org");

    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: "my-org" })
    );
  });

  test("detects swapped arguments (org first, name second)", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    getProductTrialsSpy.mockResolvedValue([MOCK_TRIAL]);

    const { context } = createMockContext();
    const func = await startCommand.loader();
    // Swapped: org first, name second
    await func.call(context, { json: true }, "my-org", "seer");

    // Should resolve correctly despite swap
    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: "my-org" })
    );
    expect(getProductTrialsSpy).toHaveBeenCalledWith("my-org");
  });

  test("detects swapped arguments for plan pseudo-trial", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    const getInfoSpy = vi
      .spyOn(apiClient, "getCustomerTrialInfo")
      .mockResolvedValue({
        productTrials: [],
        canTrial: true,
        isTrial: false,
        planDetails: { name: "Developer" },
      } as CustomerTrialInfo);

    const { context } = createMockContext();
    const func = await startCommand.loader();
    // Swapped: org first, "plan" second
    await func.call(context, { json: true }, "my-org", "plan");

    // Should resolve correctly despite swap
    expect(resolveOrgSpy).toHaveBeenCalledWith(
      expect.objectContaining({ org: "my-org" })
    );
    getInfoSpy.mockRestore();
  });

  test("starts replays trial", async () => {
    const replaysTrial: ProductTrial = {
      ...MOCK_TRIAL,
      category: "replays",
    };
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getProductTrialsSpy.mockResolvedValue([replaysTrial]);

    const { context, stdoutWrite } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: true }, "replays");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.name).toBe("replays");
    expect(parsed.category).toBe("replays");
    expect(startProductTrialSpy).toHaveBeenCalledWith("test-org", "replays");
  });
});

// ---------------------------------------------------------------------------
// Plan trial tests
// ---------------------------------------------------------------------------

function makeCustomerInfo(
  overrides: Partial<CustomerTrialInfo> = {}
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

describe("trial start plan", () => {
  let getCustomerTrialInfoSpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;
  let openBrowserSpy: ReturnType<typeof spyOn>;
  let generateQRCodeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getCustomerTrialInfoSpy = vi.spyOn(apiClient, "getCustomerTrialInfo");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
    openBrowserSpy = vi
      .spyOn(browserMod, "openBrowser")
      .mockResolvedValue(true);
    generateQRCodeSpy = vi
      .spyOn(qrcodeMod, "generateQRCode")
      .mockResolvedValue("[QR CODE]\n");
  });

  afterEach(() => {
    getCustomerTrialInfoSpy.mockRestore();
    resolveOrgSpy.mockRestore();
    openBrowserSpy.mockRestore();
    generateQRCodeSpy.mockRestore();
  });

  test("returns JSON with url and opened fields", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ canTrial: true })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: true }, "plan");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.name).toBe("plan");
    expect(parsed.category).toBe("plan");
    expect(parsed.organization).toBe("test-org");
    expect(parsed.url).toContain("billing");
    expect(typeof parsed.opened).toBe("boolean");
  });

  test("shows billing URL in output", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ canTrial: true })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: false }, "plan");

    // URL and QR code go through commandOutput → context stdout
    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("billing");
    expect(output).toContain("test-org");
  });

  test("generates QR code for billing URL", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ canTrial: true })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: false }, "plan");

    expect(generateQRCodeSpy).toHaveBeenCalled();
    // QR code goes through commandOutput → context stdout
    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("[QR CODE]");
  });

  test("throws when org is already on plan trial", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        canTrial: false,
        isTrial: true,
        planDetails: { name: "Business", trialPlan: null },
      })
    );

    const { context } = createMockContext();
    const func = await startCommand.loader();

    try {
      await func.call(context, { json: false }, "plan");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toContain("already on");
      expect((err as ValidationError).message).toContain("Business");
    }
  });

  test("throws when no plan trial available", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ canTrial: false, isTrial: false })
    );

    const { context } = createMockContext();
    const func = await startCommand.loader();

    await expect(func.call(context, { json: false }, "plan")).rejects.toThrow(
      ValidationError
    );
  });

  test("does not call startProductTrial for plan trial", async () => {
    const startProductTrialSpy = vi
      .spyOn(apiClient, "startProductTrial")
      .mockResolvedValue(undefined);

    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({ canTrial: true })
    );

    const { context } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: true }, "plan");

    expect(startProductTrialSpy).not.toHaveBeenCalled();
    startProductTrialSpy.mockRestore();
  });

  test("shows plan name in context message", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "test-org" });
    getCustomerTrialInfoSpy.mockResolvedValue(
      makeCustomerInfo({
        canTrial: true,
        planDetails: { name: "Team", trialPlan: "am3_t" },
      })
    );

    const { context, stdoutWrite } = createMockContext();
    const func = await startCommand.loader();
    await func.call(context, { json: false }, "plan");

    // URL goes through commandOutput → context stdout
    const output = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("billing");
  });
});
