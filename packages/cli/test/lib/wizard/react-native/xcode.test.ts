import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import {
  addSentryWithBundledScriptsToBundleShellScript,
  doesBundlePhaseIncludeSentry,
  findBundlePhase,
  findDebugFilesUploadPhase,
  ErrorPatchSnippet,
  usesSwiftPMAutolinking,
} from "../../../../src/lib/wizard/react-native/xcode.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { makeCodeSnippet } from "../../../../src/lib/wizard/utils/clack/index.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as clack from "@clack/prompts";

vi.mock("@clack/prompts", async () => ({
  ...(await vi.importActual<typeof clack>("@clack/prompts")),
}));

describe("react-native xcode", () => {
  beforeEach(() => {
    vi.spyOn(clack.log, "error").mockImplementation(() => {
      /* empty */
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("addSentryBundledScriptsToBundleShellScript", () => {
    it("adds sentry cli to rn bundle build phase", () => {
      const input = `set -e

WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="../node_modules/react-native/scripts/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT $REACT_NATIVE_XCODE"`;
      // actual shell script looks like this:
      // /bin/sh -c "$WITH_ENVIRONMENT \"$REACT_NATIVE_XCODE\""
      // but during parsing xcode library removes the quotes
      const expectedOutput = `set -e

WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
SENTRY_XCODE="../node_modules/@sentry/react-native/scripts/sentry-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT $SENTRY_XCODE"`;

      expect(addSentryWithBundledScriptsToBundleShellScript(input)).toBe(
        expectedOutput,
      );
    });

    it("adds sentry cli to rn bundle build phase for versions of RN that use REACT_NATIVE_PATH env variable", () => {
      const input = `set -e

WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="$REACT_NATIVE_PATH/scripts/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT $REACT_NATIVE_XCODE"`;
      // actual shell script looks like this:
      // /bin/sh -c "$WITH_ENVIRONMENT \"$REACT_NATIVE_XCODE\""
      // but during parsing xcode library removes the quotes
      const expectedOutput = `set -e

WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
SENTRY_XCODE="$REACT_NATIVE_PATH/../@sentry/react-native/scripts/sentry-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT $SENTRY_XCODE"`;

      expect(addSentryWithBundledScriptsToBundleShellScript(input)).toBe(
        expectedOutput,
      );
    });

    it("does not add sentry cli to rn bundle build phase if $REACT_NATIVE_XCODE is not present and shows code snippet", () => {
      const input = `set -e
  
  WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
  REACT_NATIVE_XCODE="../node_modules/react-native/scripts/react-native-xcode.sh"
  
  /bin/sh -c "$WITH_ENVIRONMENT $NOT_REACT_NATIVE_XCODE"`;

      expect(addSentryWithBundledScriptsToBundleShellScript(input)).toEqual(
        new ErrorPatchSnippet(
          makeCodeSnippet(true, (unchanged, plus, _minus) => {
            return unchanged(`WITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="$REACT_NATIVE_PATH/scripts/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT ${plus(
              `\\"/bin/sh ../node_modules/@sentry/react-native/scripts/sentry-xcode.sh `,
            )}$REACT_NATIVE_XCODE${plus(`\\"`)}"
`);
          }),
        ),
      );
      expect(clack.log.error).toHaveBeenCalledWith(
        `Failed to patch ${chalk.cyan(
          "Bundle React Native code and images",
        )} build phase.`,
      );
    });

    it("adds sentry cli to expo bundle build phase", () => {
      const input = `
if [[ -f "$PODS_ROOT/../.xcode.env" ]]; then
  source "$PODS_ROOT/../.xcode.env"
fi
if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then
  source "$PODS_ROOT/../.xcode.env.local"
fi

# The project root by default is one level up from the ios directory
export PROJECT_ROOT="$PROJECT_DIR"/..

if [[ "$CONFIGURATION" = *Debug* ]]; then
  export SKIP_BUNDLING=1
fi
if [[ -z "$ENTRY_FILE" ]]; then
  # Set the entry JS file using the bundler's entry resolution.
  export ENTRY_FILE="$("$NODE_BINARY" -e "require('expo/scripts/resolveAppEntry')" "$PROJECT_ROOT" ios absolute | tail -n 1)"
fi

if [[ -z "$CLI_PATH" ]]; then
  # Use Expo CLI
  export CLI_PATH="$("$NODE_BINARY" --print "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })")"
fi
if [[ -z "$BUNDLE_COMMAND" ]]; then
  # Default Expo CLI command for bundling
  export BUNDLE_COMMAND="export:embed"
fi

# Source .xcode.env.updates if it exists to allow
# SKIP_BUNDLING to be unset if needed
if [[ -f "$PODS_ROOT/../.xcode.env.updates" ]]; then
  source "$PODS_ROOT/../.xcode.env.updates"
fi
# Source local changes to allow overrides
# if needed
if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then
  source "$PODS_ROOT/../.xcode.env.local"
fi

\`"$NODE_BINARY" --print "require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'"\`
`;

      const expectedOutput = `
if [[ -f "$PODS_ROOT/../.xcode.env" ]]; then
  source "$PODS_ROOT/../.xcode.env"
fi
if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then
  source "$PODS_ROOT/../.xcode.env.local"
fi

# The project root by default is one level up from the ios directory
export PROJECT_ROOT="$PROJECT_DIR"/..

if [[ "$CONFIGURATION" = *Debug* ]]; then
  export SKIP_BUNDLING=1
fi
if [[ -z "$ENTRY_FILE" ]]; then
  # Set the entry JS file using the bundler's entry resolution.
  export ENTRY_FILE="$("$NODE_BINARY" -e "require('expo/scripts/resolveAppEntry')" "$PROJECT_ROOT" ios absolute | tail -n 1)"
fi

if [[ -z "$CLI_PATH" ]]; then
  # Use Expo CLI
  export CLI_PATH="$("$NODE_BINARY" --print "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })")"
fi
if [[ -z "$BUNDLE_COMMAND" ]]; then
  # Default Expo CLI command for bundling
  export BUNDLE_COMMAND="export:embed"
fi

# Source .xcode.env.updates if it exists to allow
# SKIP_BUNDLING to be unset if needed
if [[ -f "$PODS_ROOT/../.xcode.env.updates" ]]; then
  source "$PODS_ROOT/../.xcode.env.updates"
fi
# Source local changes to allow overrides
# if needed
if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then
  source "$PODS_ROOT/../.xcode.env.local"
fi

/bin/sh \`"$NODE_BINARY" --print "require('path').dirname(require.resolve('@sentry/react-native/package.json')) + '/scripts/sentry-xcode.sh'"\` \`"$NODE_BINARY" --print "require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'"\`
`;

      expect(addSentryWithBundledScriptsToBundleShellScript(input)).toBe(
        expectedOutput,
      );
    });

    it("if patching fails it does not add sentry cli to expo bundle build phase and shows code snippet", () => {
      const input = `
if [[ -f "$PODS_ROOT/../.xcode.env" ]]; then
  source "$PODS_ROOT/../.xcode.env"
fi
if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then
  source "$PODS_ROOT/../.xcode.env.local"
fi

# The project root by default is one level up from the ios directory
export PROJECT_ROOT="$PROJECT_DIR"/..

if [[ "$CONFIGURATION" = *Debug* ]]; then
  export SKIP_BUNDLING=1
fi
if [[ -z "$ENTRY_FILE" ]]; then
  # Set the entry JS file using the bundler's entry resolution.
  export ENTRY_FILE="$("$NODE_BINARY" -e "require('expo/scripts/resolveAppEntry')" "$PROJECT_ROOT" ios absolute | tail -n 1)"
fi
`;
      expect(addSentryWithBundledScriptsToBundleShellScript(input)).toEqual(
        new ErrorPatchSnippet(
          makeCodeSnippet(true, (unchanged, plus, _minus) => {
            return unchanged(
              `${plus(
                `/bin/sh \`"$NODE_BINARY" --print "require('path').dirname(require.resolve('@sentry/react-native/package.json')) + '/scripts/sentry-xcode.sh'"\``,
              )} \`"$NODE_BINARY" --print "require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'"\``,
            );
          }),
        ),
      );
      expect(clack.log.error).toHaveBeenCalledWith(
        `Failed to patch ${chalk.cyan(
          "Bundle React Native code and images",
        )} build phase.`,
      );
    });
  });

  describe("findBundlePhase", () => {
    it("returns build phase with react native xcode shell script", () => {
      const inputMap = {
        1: {
          shellScript: "foo",
        },
        2: {
          shellScript: "bar",
        },
        3: {
          shellScript: `set -e
WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="../node_modules/react-native/scripts/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT "$REACT_NATIVE_XCODE""

`,
        },
        4: {
          shellScript: "qux",
        },
      };

      const expected = {
        shellScript: `set -e
WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="../node_modules/react-native/scripts/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT "$REACT_NATIVE_XCODE""

`,
      };

      expect(findBundlePhase(inputMap)).toEqual(expected);
    });

    it("returns undefined if bundle phase not present", () => {
      const inputMap = {
        1: {
          shellScript: "foo",
        },
        2: {
          shellScript: "bar",
        },
        3: {
          // note different path to the script
          shellScript: `set -e
WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="../node_modules/react-native/unknown/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT "$REACT_NATIVE_XCODE""

`,
        },
        4: {
          shellScript: "qux",
        },
      };

      expect(findBundlePhase(inputMap)).toBeUndefined();
    });
  });

  describe("doesBundlePhaseIncludeSentry", () => {
    it("returns true for script containing sentry cli calling react native xcode command", () => {
      const input = {
        shellScript: `set -e
WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="../node_modules/react-native/scripts/react-native-xcode.sh"
SENTRY_CLI="sentry-cli react-native xcode"

/bin/sh -c "$WITH_ENVIRONMENT "$SENTRY_CLI $REACT_NATIVE_XCODE""
`,
      };
      expect(doesBundlePhaseIncludeSentry(input)).toBeTruthy();
    });

    it("returns true for script containing sentry bundled script", () => {
      const input = {
        shellScript: `set -e
WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="../node_modules/react-native/scripts/react-native-xcode.sh"
SENTRY_CLI="sentry-cli react-native xcode"

/bin/sh -c "$WITH_ENVIRONMENT \\"/bin/sh ../node_modules/@sentry/react-native/scripts/sentry-xcode.sh $REACT_NATIVE_XCODE"\\"
`,
      };
      expect(doesBundlePhaseIncludeSentry(input)).toBeTruthy();
    });

    it("returns false", () => {
      const input = {
        // note sentry-cli can be part of the script but doesn't call react native xcode script
        shellScript: `set -e
WITH_ENVIRONMENT="../node_modules/react-native/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="../node_modules/react-native/scripts/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT "$REACT_NATIVE_XCODE""

sentry-cli --version
`,
      };
      expect(doesBundlePhaseIncludeSentry(input)).toBeFalsy();
    });
  });

  describe("findDebugFilesUploadPhase", () => {
    it("returns debug files build phase using debug files command", () => {
      const input = {
        1: {
          shellScript: "foo",
        },
        2: {
          shellScript: `set -e
sentry-cli debug-files upload path/to/dsym --include-sources
`,
        },
      };
      const expected = [
        "2",
        {
          shellScript: `set -e
sentry-cli debug-files upload path/to/dsym --include-sources
`,
        },
      ];
      expect(findDebugFilesUploadPhase(input)).toEqual(expected);
    });

    it("returns debug files build phase with sentry-cli absolute path", () => {
      const input = {
        1: {
          shellScript: "foo",
        },
        2: {
          shellScript: `set -e
/path/to/bin/sentry-cli debug-files upload path/to/dsym --include-sources
`,
        },
      };
      const expected = [
        "2",
        {
          shellScript: `set -e
/path/to/bin/sentry-cli debug-files upload path/to/dsym --include-sources
`,
        },
      ];
      expect(findDebugFilesUploadPhase(input)).toEqual(expected);
    });

    it("returns debug files build phase using dsym command", () => {
      const input = {
        1: {
          shellScript: "foo",
        },
        2: {
          shellScript: `set -e
sentry-cli upload-dsym path/to/dsym --include-sources
`,
        },
      };
      const expected = [
        "2",
        {
          shellScript: `set -e
sentry-cli upload-dsym path/to/dsym --include-sources
`,
        },
      ];
      expect(findDebugFilesUploadPhase(input)).toEqual(expected);
    });

    it("returns debug files build phase using bundled scripts", () => {
      const input = {
        1: {
          shellScript: "foo",
        },
        2: {
          shellScript: `/bin/sh ../node_modules/@sentry/react-native/scripts/sentry-xcode-debug-files.sh`,
        },
      };
      const expected = [
        "2",
        {
          shellScript: `/bin/sh ../node_modules/@sentry/react-native/scripts/sentry-xcode-debug-files.sh`,
        },
      ];
      expect(findDebugFilesUploadPhase(input)).toEqual(expected);
    });

    it("returns undefined if build phase not present", () => {
      const input = {
        1: {
          shellScript: "foo",
        },
        2: {
          // sentry-cli present but with different command
          shellScript: "sentry-cli sourcempas upload",
        },
      };

      expect(findDebugFilesUploadPhase(input)).toBeUndefined();
    });
  });

  describe("usesSwiftPMAutolinking", () => {
    const writeProject = (content: string) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-xcode-project"));
      const projectPath = path.join(dir, "project.pbxproj");
      fs.writeFileSync(projectPath, content);
      return projectPath;
    };

    it("returns true for a project with the autolinking package", () => {
      const projectPath =
        writeProject(`/* Begin XCLocalSwiftPackageReference section */
		C2FECF1430FDAAE3BF355839 /* XCLocalSwiftPackageReference "build/generated/autolinking" */ = {isa = XCLocalSwiftPackageReference; relativePath = build/generated/autolinking;};
/* End XCLocalSwiftPackageReference section */`);

      expect(usesSwiftPMAutolinking(projectPath)).toBe(true);
    });

    it("returns false for a CocoaPods project", () => {
      const projectPath = writeProject(
        `shellScript = ""\${PODS_ROOT}/Target Support Files/Pods-App/Pods-App-frameworks.sh"\n";`,
      );

      expect(usesSwiftPMAutolinking(projectPath)).toBe(false);
    });

    it("returns false if the project file does not exist", () => {
      expect(
        usesSwiftPMAutolinking(path.join(os.tmpdir(), "missing.pbxproj")),
      ).toBe(false);
    });
  });
});
