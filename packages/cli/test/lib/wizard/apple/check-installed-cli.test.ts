import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  whichSync: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  log: { info: mocks.info, warn: mocks.warn },
}));

vi.mock("../../../../src/lib/which.js", () => ({
  whichSync: mocks.whichSync,
}));

import {
  checkInstalledCLI,
  xcodeSearchDirs,
} from "../../../../src/lib/wizard/apple/check-installed-cli.js";

describe("checkInstalledCLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches only the directories an Xcode build phase sees", () => {
    mocks.whichSync.mockReturnValue("/opt/homebrew/bin/sentry");

    expect(checkInstalledCLI()).toBe("/opt/homebrew/bin/sentry");
    expect(mocks.whichSync).toHaveBeenCalledWith("sentry", {
      PATH: xcodeSearchDirs().join(":"),
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("falls back to npx when only npx is in reach", () => {
    mocks.whichSync.mockImplementation((command: string) =>
      command === "npx" ? "/opt/homebrew/bin/npx" : null,
    );

    expect(checkInstalledCLI()).toBe("/opt/homebrew/bin/npx");
    const message = String(mocks.info.mock.calls[0]?.[0]);
    expect(message).toContain("`npx sentry`");
    expect(message).toContain("brew install getsentry/tools/sentry");
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("prints v4 install instructions when neither sentry nor npx is in reach", () => {
    mocks.whichSync.mockReturnValue(null);

    expect(checkInstalledCLI("Custom warning.")).toBeUndefined();
    const message = String(mocks.warn.mock.calls[0]?.[0]);
    expect(message).toContain("Custom warning.");
    expect(message).toContain("brew install getsentry/tools/sentry");
    expect(message).toContain(
      "curl https://cli.sentry.dev/install -fsS | bash",
    );
    expect(message).toContain("npm install -g sentry");
    expect(message).not.toContain("sentry-cli");
  });
});

describe("xcodeSearchDirs", () => {
  it("lists the installer, Homebrew and system directories", () => {
    expect(xcodeSearchDirs("/Users/dev")).toEqual([
      "/Users/dev/.local/bin",
      "/Users/dev/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);
  });
});
