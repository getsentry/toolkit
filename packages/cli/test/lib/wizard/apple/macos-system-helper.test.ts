import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MacOSSystemHelpers } from "../../../../src/lib/wizard/apple/macos-system-helper.js";

const appleProjectsPath = path.resolve(
  __dirname,
  "../../../fixtures/wizard/apple",
);
const projectWithSynchronizedFolders = path.join(
  appleProjectsPath,
  "xcode-15-compatible-project/Project.xcodeproj",
);

// The path to the Xcode.app can be different on different machines, therefore me must detect the path
// to the Xcode.app using the `xcode-select` command.
// The same goes for the SDK path, which can be different on different machines depending if the Command Line Tools
// or the full Xcode is installed.
//
// While creating these tests we ensured that the implementation in the tests is correct by comparing.
// We must not change the implementation in the test code unless we are sure that the implementation is correct!

describe("MacOSSystemHelpers", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("findSDKRootDirectoryPath", () => {
    test.runIf(process.platform === "darwin")(
      "should return the SDK root directory path",
      () => {
        // -- Act --
        const sdkRootDirectoryPath =
          MacOSSystemHelpers.findSDKRootDirectoryPath();

        // -- Assert --
        const candidates = [
          // Matches the path for the Command Line Tools, e.g. /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
          /^\/Library\/Developer\/CommandLineTools\/SDKs\/MacOSX\.sdk$/i,
          // Matches the path for the default Xcode.app, e.g. /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
          /^\/Applications\/Xcode\.app\/Contents\/Developer\/Platforms\/MacOSX\.platform\/Developer\/SDKs\/MacOSX\.sdk$/i,
          // Matches the path for any Xcode.app, e.g. /Applications/Xcode-16.0.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
          /^\/Applications\/Xcode.+\.app\/Contents\/Developer\/Platforms\/MacOSX\.platform\/Developer\/SDKs\/MacOSX\.sdk$/i,
        ];

        expect(sdkRootDirectoryPath).toSatisfy((path: string) =>
          candidates.some((regex) => regex.test(path)),
        );
      },
    );

    test.runIf(process.platform !== "darwin")(
      "should return undefined on non-macOS platforms",
      () => {
        // The purpose of this test is to verify that the implementation of findSDKRootDirectoryPath() is still unchanged

        // -- Act --
        const sdkRootDirectoryPath =
          MacOSSystemHelpers.findSDKRootDirectoryPath();

        // -- Assert --
        expect(sdkRootDirectoryPath).toBeUndefined();
      },
    );
  });

  describe("findDeveloperDirectoryPath", () => {
    test.runIf(process.platform === "darwin")(
      "should return the developer directory path",
      () => {
        // -- Act --
        const developerDirectoryPath =
          MacOSSystemHelpers.findDeveloperDirectoryPath();

        // -- Assert --
        const candidates = [
          // Matches the path for the default Xcode.app, e.g. /Applications/Xcode.app/Contents/Developer
          /^\/Applications\/Xcode\.app\/Contents\/Developer$/i,
          // Matches the path for any Xcode.app, e.g. /Applications/Xcode-16.0.app/Contents/Developer
          /^\/Applications\/Xcode.+\.app\/Contents\/Developer$/i,
        ];

        expect(developerDirectoryPath).toSatisfy((path: string) =>
          candidates.some((regex) => regex.test(path)),
        );
      },
    );
    test.runIf(process.platform !== "darwin")(
      "should return undefined on non-macOS platforms",
      () => {
        // The purpose of this test is to verify that the implementation of findDeveloperDirectoryPath() is still unchanged

        // -- Act --
        const developerDirectoryPath =
          MacOSSystemHelpers.findDeveloperDirectoryPath();

        // -- Assert --
        expect(developerDirectoryPath).toBeUndefined();
      },
    );
  });

  describe("readXcodeBuildSettings", () => {
    test.runIf(process.platform === "darwin")(
      "should return the build settings",
      () => {
        // -- Act --
        const buildSettings = MacOSSystemHelpers.readXcodeBuildSettings(
          projectWithSynchronizedFolders,
        );

        // -- Assert --
        // The build settings are a massive list of key-value pairs, so we'll just check a few of them
        // which are relevant for our use cases.
        expect(buildSettings?.["CONFIGURATION_BUILD_DIR"]).toEqual(
          path.join(
            appleProjectsPath,
            "xcode-15-compatible-project/build/Release-unknown",
          ),
        );
        expect(buildSettings?.["TARGET_BUILD_DIR"]).toEqual(
          path.join(
            appleProjectsPath,
            "xcode-15-compatible-project/build/Release-unknown",
          ),
        );
      },
      // Increased timeout to 10 seconds due to timeout errors for Node 18 and Node 20
      10000,
    );

    test.runIf(process.platform !== "darwin")(
      "should return undefined on non-macOS platforms",
      () => {
        // The purpose of this test is to verify that the implementation of readXcodeBuildSettings() is still unchanged

        // -- Act --
        const buildSettings = MacOSSystemHelpers.readXcodeBuildSettings(
          projectWithSynchronizedFolders,
        );

        // -- Assert --
        expect(buildSettings).toBeUndefined();
      },
    );
  });
});
