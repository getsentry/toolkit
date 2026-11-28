// Note for future maintainers:
//
// This test file is mocking the `child_process` module.
// As other tests are using the `child_process` module, we can not have them in the same file.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MacOSSystemHelpers } from "../../../../src/lib/wizard/apple/macos-system-helper.js";

const { execFileSyncMock } = vi.hoisted(() => {
  return {
    execFileSyncMock: vi.fn(),
  };
});

vi.mock("node:child_process", async () => {
  return {
    ...(await vi.importActual("node:child_process")),
    execFileSync: execFileSyncMock,
  };
});

describe("MacOSSystemHelpers", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("readXcodeBuildSettings", () => {
    describe("project path", () => {
      it("passes the path as one argument without a shell", () => {
        // -- Arrange --
        const projectPath = 'some path" && echo "$(touch pwned)"';

        execFileSyncMock.mockImplementationOnce(() => {
          return "   ACTION = build";
        });

        // -- Act --
        const buildSettings =
          MacOSSystemHelpers.readXcodeBuildSettings(projectPath);

        // -- Assert --
        expect(buildSettings).toEqual({
          ACTION: "build",
        });
        expect(execFileSyncMock).toHaveBeenCalledWith(
          "xcodebuild",
          ["-project", projectPath, "-showBuildSettings"],
          { encoding: "utf8" },
        );
      });
    });
  });
});
