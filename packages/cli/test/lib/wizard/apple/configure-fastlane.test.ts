import { beforeEach, describe, expect, it, vi } from "vitest";
import { WizardExitError } from "../../../../src/lib/errors.js";
import { configureFastlane } from "../../../../src/lib/wizard/apple/configure-fastlane.js";

const CANCEL = Symbol("clack:cancel");

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  addSentryToFastlane: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: mocks.confirm,
  isCancel: (value: unknown) => typeof value === "symbol",
  cancel: vi.fn(),
  log: { step: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../../src/lib/wizard/apple/fastlane.js", () => ({
  fastFile: () => "/project/fastlane/Fastfile",
  addSentryToFastlane: mocks.addSentryToFastlane,
}));

const options = {
  projectDir: "/project",
  orgSlug: "org-slug",
  projectSlug: "project-slug",
};

describe("configureFastlane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits without touching the Fastfile when the prompt is cancelled", async () => {
    mocks.confirm.mockResolvedValue(CANCEL);

    await expect(configureFastlane(options)).rejects.toThrow(WizardExitError);
    expect(mocks.addSentryToFastlane).not.toHaveBeenCalled();
  });

  it("adds the lane when the user confirms", async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.addSentryToFastlane.mockResolvedValue(true);

    await configureFastlane(options);

    expect(mocks.addSentryToFastlane).toHaveBeenCalledWith(
      "/project",
      "org-slug",
      "project-slug",
    );
  });
});
