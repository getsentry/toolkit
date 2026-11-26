/**
 * Read macOS developer paths the Xcode project manager resolves group paths
 * against: Xcode's developer directory, SDK roots, and derived data.
 */

import { execSync } from "node:child_process";
import { debug } from "../utils/debug.js";

export class MacOSSystemHelpers {
  static findSDKRootDirectoryPath(): string | undefined {
    try {
      // Some Candidates:
      // - /Applications/Xcode-16.3.0.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
      // - /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
      const sdkPath = execSync("xcrun --show-sdk-path", {
        encoding: "utf8",
      }).trim();
      return sdkPath;
    } catch (error) {
      debug(`Failed to find SDK root directory path: ${error as string}`);
      return undefined;
    }
  }

  static findDeveloperDirectoryPath(): string | undefined {
    try {
      // Some Candidates:
      // - /Applications/Xcode.app/Contents/Developer
      // - /Applications/Xcode-16.3.0.app/Contents/Developer
      const developerPath = execSync("xcode-select --print-path", {
        encoding: "utf8",
      }).trim();
      return developerPath;
    } catch (error) {
      debug(`Failed to find developer directory path: ${error as string}`);
      return undefined;
    }
  }

  static readXcodeBuildSettings(
    projectPath: string,
  ): Record<string, string> | undefined {
    try {
      // The child_process.execSync() method is generally identical to exec with the exception that the method will not return until the child process has fully closed.
      // When a timeout has been encountered and killSignal is sent, the method won't return until the process has completely exited.
      // If the child process intercepts and handles the SIGTERMsignal and doesn't exit, the parent process will wait until the child process has exited.
      //
      // If the process times out or has a non-zero exit code, this method will throw.
      // The Error object will contain the entire result from spawnSync.
      //
      // IMPORTANT:
      //      Never pass unsanitized user input to this function.
      //      Any input containing shell metacharacters may be used to trigger arbitrary command execution.
      const output = execSync(
        [
          `xcodebuild`,
          `-project`,
          projectPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
          `-showBuildSettings`,
        ]
          .map((arg) => `"${arg.trim()}"`)
          .join(" "),
        {
          encoding: "utf8",
        },
      ).trim();
      // --- Example Output: ---
      // Command line invocation:
      // /Applications/Xcode-16.3.0.app/Contents/Developer/usr/bin/xcodebuild -project ./fixtures/test-applications/apple/project-with-synchronized-folders/Project.xcodeproj -showBuildSettings
      //
      // Build settings for action build and target Project:
      //     ACTION = build
      //     ALLOW_BUILD_REQUEST_OVERRIDES = NO
      //     ALLOW_TARGET_PLATFORM_SPECIALIZATION = YES
      //     ALTERNATE_GROUP = staff
      //     ...
      const lines = output.split("\n");
      const settings: Record<string, string> = {};
      lines.forEach((line) => {
        const match = line.match(/^\s*(\w+)\s+=\s+(.*)$/);
        if (match?.[1] !== undefined && match[2] !== undefined) {
          settings[match[1]] = match[2];
        }
      });

      return settings;
    } catch (error) {
      debug(`Failed to read Xcode build settings: ${error as string}`);
      return undefined;
    }
  }
}
