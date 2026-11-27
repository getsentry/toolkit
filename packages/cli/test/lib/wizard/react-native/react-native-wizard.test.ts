import { beforeEach, describe, expect, it, vi } from "vitest";
import { WizardExitError } from "../../../../src/lib/errors.js";
import { confirmFirstSentryException } from "../../../../src/lib/wizard/react-native/react-native-wizard.js";

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock("@clack/prompts", () => ({
  confirm: mocks.confirm,
  isCancel: (value: unknown) => typeof value === "symbol",
  cancel: vi.fn(),
  log: { step: vi.fn() },
}));

describe("confirmFirstSentryException", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("exits when the prompt is cancelled", async () => {
    mocks.confirm.mockResolvedValue(Symbol("clack:cancel"));

    await expect(
      confirmFirstSentryException("org-slug", "123"),
    ).rejects.toThrow(WizardExitError);
  });

  it("returns the answer", async () => {
    mocks.confirm.mockResolvedValue(false);

    await expect(confirmFirstSentryException("org-slug", "123")).resolves.toBe(
      false,
    );
  });
});
