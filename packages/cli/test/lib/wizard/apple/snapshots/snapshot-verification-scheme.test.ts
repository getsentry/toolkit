// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveSnapshotVerificationSchemeName } from "../../../../../src/lib/wizard/apple/snapshots/snapshot-verification-scheme.js";

function createXcodeProject(): string {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "snapshot-verification-scheme-"),
  );
  const xcodeprojPath = path.join(projectDir, "App.xcodeproj");
  fs.mkdirSync(xcodeprojPath, { recursive: true });
  return xcodeprojPath;
}

function writeScheme({
  name,
  testTargetNames,
  xcodeprojPath,
}: {
  name: string;
  testTargetNames: string[];
  xcodeprojPath: string;
}): void {
  const schemeDirectory = path.join(xcodeprojPath, "xcshareddata", "xcschemes");
  fs.mkdirSync(schemeDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(schemeDirectory, `${name}.xcscheme`),
    getSchemeXml(testTargetNames),
    "utf8",
  );
}

function writeSchemeManagementPlist({
  schemeNames,
  xcodeprojPath,
}: {
  schemeNames: string[];
  xcodeprojPath: string;
}): void {
  const schemeDirectory = path.join(
    xcodeprojPath,
    "xcuserdata",
    "cam.xcuserdatad",
    "xcschemes",
  );
  fs.mkdirSync(schemeDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(schemeDirectory, "xcschememanagement.plist"),
    getSchemeManagementPlistXml(schemeNames),
    "utf8",
  );
}

function getSchemeXml(testTargetNames: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme version="1.7">
  <TestAction>
    <Testables>
${testTargetNames
  .map(
    (testTargetName) => `      <TestableReference skipped="NO">
        <BuildableReference
          BlueprintIdentifier="${testTargetName.toUpperCase()}ID"
          BlueprintName="${testTargetName}"
          BuildableName="${testTargetName}.xctest">
        </BuildableReference>
      </TestableReference>`,
  )
  .join("\n")}
    </Testables>
  </TestAction>
</Scheme>
`;
}

function getSchemeManagementPlistXml(schemeNames: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>SchemeUserState</key>
    <dict>
${schemeNames
  .map(
    (schemeName) => `      <key>${schemeName}.xcscheme_^#shared#^_</key>
      <dict>
        <key>orderHint</key>
        <integer>0</integer>
      </dict>`,
  )
  .join("\n")}
    </dict>
  </dict>
</plist>
`;
}

describe("resolveSnapshotVerificationSchemeName", () => {
  it("returns the explicit scheme that contains the hosted test target", () => {
    const xcodeprojPath = createXcodeProject();
    writeScheme({
      name: "App-Staging",
      testTargetNames: ["AppTests"],
      xcodeprojPath,
    });
    writeScheme({
      name: "App-Production",
      testTargetNames: ["OtherTests"],
      xcodeprojPath,
    });

    expect(
      resolveSnapshotVerificationSchemeName({
        hostedTestTargetName: "AppTests",
        xcodeprojPath,
      }),
    ).toBe("App-Staging");
  });

  it("returns undefined when the only explicit scheme does not contain the hosted test target", () => {
    const xcodeprojPath = createXcodeProject();
    writeScheme({
      name: "App-CI",
      testTargetNames: ["OtherTests"],
      xcodeprojPath,
    });

    expect(
      resolveSnapshotVerificationSchemeName({
        hostedTestTargetName: "AppTests",
        xcodeprojPath,
      }),
    ).toBeUndefined();
  });

  it("returns the only managed implicit scheme when no scheme file exists", () => {
    const xcodeprojPath = createXcodeProject();
    writeSchemeManagementPlist({
      schemeNames: ["cake"],
      xcodeprojPath,
    });

    expect(
      resolveSnapshotVerificationSchemeName({
        hostedTestTargetName: "sausageTests",
        xcodeprojPath,
      }),
    ).toBe("cake");
  });

  it("returns undefined for ambiguous schemes", () => {
    const xcodeprojPath = createXcodeProject();
    writeSchemeManagementPlist({
      schemeNames: ["App-Staging", "App-Production"],
      xcodeprojPath,
    });

    expect(
      resolveSnapshotVerificationSchemeName({
        hostedTestTargetName: "AppTests",
        xcodeprojPath,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when scheme discovery cannot traverse the project path", () => {
    const projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "snapshot-verification-scheme-file-"),
    );
    const xcodeprojPath = path.join(projectDir, "App.xcodeproj");
    fs.writeFileSync(xcodeprojPath, "", "utf8");

    expect(
      resolveSnapshotVerificationSchemeName({
        hostedTestTargetName: "AppTests",
        xcodeprojPath,
      }),
    ).toBeUndefined();
  });
});
