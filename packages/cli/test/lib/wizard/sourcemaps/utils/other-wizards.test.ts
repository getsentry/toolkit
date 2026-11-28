import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasWizardRunner,
  runWizard,
} from "../../../../../src/lib/wizard/run.js";
import { checkIfMoreSuitableWizardExistsAndAskForRedirect } from "../../../../../src/lib/wizard/sourcemaps/utils/other-wizards.js";
import { getPackageDotJson } from "../../../../../src/lib/wizard/utils/clack/index.js";
import type { WizardOptions } from "../../../../../src/lib/wizard/utils/types.js";

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock("@clack/prompts", () => ({
  log: { warn: vi.fn() },
  select: selectMock,
  isCancel: vi.fn().mockReturnValue(false),
}));
vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual(
    "../../../../../src/lib/wizard/utils/clack/index.js",
  )),
  getPackageDotJson: vi.fn(),
}));
vi.mock("../../../../../src/lib/wizard/run.js", () => ({
  hasWizardRunner: vi.fn(),
  runWizard: vi.fn().mockResolvedValue(undefined),
}));

type SelectArgs = { options: { value: string }[] };

function offeredChoices(): string[] {
  const [args] = (selectMock.mock.calls[0] ?? []) as [SelectArgs?];
  return args?.options.map((option) => option.value) ?? [];
}

describe("checkIfMoreSuitableWizardExistsAndAskForRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPackageDotJson).mockResolvedValue({
      dependencies: { "@sentry/sveltekit": "^10", "@sveltejs/kit": "^2" },
    });
  });

  it("offers the framework wizard when this version has it", async () => {
    vi.mocked(hasWizardRunner).mockReturnValue(true);
    selectMock.mockResolvedValueOnce("redirect");

    const wizard = await checkIfMoreSuitableWizardExistsAndAskForRedirect();
    const options = { telemetryEnabled: false } as WizardOptions;
    await wizard?.(options);

    expect(offeredChoices()).toEqual(["redirect", "continue", "stop"]);
    expect(runWizard).toHaveBeenCalledWith({
      integration: "sveltekit",
      wizardOptions: options,
    });
  });

  it("only offers to continue or stop when this version lacks the wizard", async () => {
    vi.mocked(hasWizardRunner).mockReturnValue(false);
    selectMock.mockResolvedValueOnce("continue");

    const wizard = await checkIfMoreSuitableWizardExistsAndAskForRedirect();

    expect(offeredChoices()).toEqual(["continue", "stop"]);
    expect(wizard).toBeUndefined();
    expect(runWizard).not.toHaveBeenCalled();
  });
});
