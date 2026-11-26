// Note for future maintainers:
//
// This test file is mocking the `child_process` module.
// As other tests are using the `child_process` module, we can not have them in the same file.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MacOSSystemHelpers } from "../../../../src/lib/wizard/apple/macos-system-helper.js";

const { execSyncMock } = vi.hoisted(() => {
  return {
    execSyncMock: vi.fn(),
  };
});

vi.mock("node:child_process", async () => {
  return {
    ...(await vi.importActual("node:child_process")),
    execSync: execSyncMock,
  };
});

describe("MacOSSystemHelpers", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("readXcodeBuildSettings", () => {
    describe("project path", () => {
      it("should escape quotes", () => {
        // -- Arrange --
        const projectPath = 'some path" && echo "Hello World"';

        // Use spyOn instead of vi.mock
        execSyncMock.mockImplementationOnce(() => {
          return "   ACTION = build";
        });

        // -- Act --
        const buildSettings =
          MacOSSystemHelpers.readXcodeBuildSettings(projectPath);

        // -- Assert --
        expect(buildSettings).toEqual({
          ACTION: "build",
        });
        // We expect the project path to be escaped
        expect(execSyncMock).toHaveBeenCalledWith(
          `"xcodebuild" "-project" "some path\\" && echo \\"Hello World\\"" "-showBuildSettings"`,
          { encoding: "utf8" },
        );
      });
    });
  });
});
