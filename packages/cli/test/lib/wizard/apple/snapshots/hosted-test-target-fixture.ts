// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import type { PBXFileReference } from "xcode";

import type { XcodeProject } from "../../../../../src/lib/wizard/apple/xcode-manager.js";

export type HostedTestTargetFixtureIds = {
  targetId: string;
  frameworksBuildPhaseId: string;
  sourcesBuildPhaseId?: string;
  debugBuildConfigurationId: string;
  releaseBuildConfigurationId: string;
  buildConfigurationListId: string;
  productReferenceId: string;
};

const fixtureProjectPath = path.resolve(
  __dirname,
  "../../../../fixtures/wizard/apple/spm-swiftui-single-target/Project.xcodeproj/project.pbxproj",
);

type HostedTestTargetFixtureOptions = {
  name?: string;
  hostAppName?: string;
  testHost?: string;
  bundleLoader?: string;
  ids?: HostedTestTargetFixtureIds;
  includeSourcesBuildPhase?: boolean;
  projectObjectId: string;
  productsGroupId: string;
};

export function copySingleTargetProjectToTemp(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const xcodeprojDir = path.join(tempDir, "Project.xcodeproj");
  fs.mkdirSync(xcodeprojDir, { recursive: true });
  fs.mkdirSync(path.join(tempDir, "Sources"), { recursive: true });
  fs.copyFileSync(
    fixtureProjectPath,
    path.join(xcodeprojDir, "project.pbxproj"),
  );
  return path.join(xcodeprojDir, "project.pbxproj");
}

export function addHostedUnitTestTarget(
  xcodeProject: XcodeProject,
  options: HostedTestTargetFixtureOptions,
): HostedTestTargetFixtureIds {
  const name = options.name ?? "ProjectTests";
  const ids = options.ids ?? hostedTestTargetFixtureIds(name);
  const hostAppName = options.hostAppName ?? "Project";
  const buildSettings = hostedUnitTestBuildSettings({
    bundleLoader: options.bundleLoader,
    hostAppName,
    name,
    testHost: options.testHost,
  });

  xcodeProject.objects.PBXFileReference = {
    ...xcodeProject.objects.PBXFileReference,
    [ids.productReferenceId]: {
      isa: "PBXFileReference",
      explicitFileType: "wrapper.cfbundle",
      includeInIndex: 0,
      path: `${name}.xctest`,
      sourceTree: "BUILT_PRODUCTS_DIR",
    } as unknown as PBXFileReference,
    [`${ids.productReferenceId}_comment`]: `${name}.xctest`,
  };

  xcodeProject.objects.PBXFrameworksBuildPhase = {
    ...xcodeProject.objects.PBXFrameworksBuildPhase,
    [ids.frameworksBuildPhaseId]: {
      isa: "PBXFrameworksBuildPhase",
      buildActionMask: 2147483647,
      files: [],
      runOnlyForDeploymentPostprocessing: 0,
    },
    [`${ids.frameworksBuildPhaseId}_comment`]: "Frameworks",
  };

  const buildPhases = [
    ...(options.includeSourcesBuildPhase && ids.sourcesBuildPhaseId
      ? [
          {
            value: ids.sourcesBuildPhaseId,
            comment: "Sources",
          },
        ]
      : []),
    {
      value: ids.frameworksBuildPhaseId,
      comment: "Frameworks",
    },
  ];

  if (options.includeSourcesBuildPhase && ids.sourcesBuildPhaseId) {
    xcodeProject.objects.PBXSourcesBuildPhase = {
      ...xcodeProject.objects.PBXSourcesBuildPhase,
      [ids.sourcesBuildPhaseId]: {
        isa: "PBXSourcesBuildPhase",
        buildActionMask: 2147483647,
        files: [],
        runOnlyForDeploymentPostprocessing: 0,
      },
      [`${ids.sourcesBuildPhaseId}_comment`]: "Sources",
    };
  }

  xcodeProject.objects.PBXNativeTarget = {
    ...xcodeProject.objects.PBXNativeTarget,
    [ids.targetId]: {
      isa: "PBXNativeTarget",
      buildConfigurationList: ids.buildConfigurationListId,
      buildPhases,
      buildRules: [],
      dependencies: [],
      name,
      packageProductDependencies: [],
      productName: name,
      productReference: ids.productReferenceId,
      productType: '"com.apple.product-type.bundle.unit-test"',
    },
    [`${ids.targetId}_comment`]: name,
  };

  xcodeProject.objects.XCBuildConfiguration = {
    ...xcodeProject.objects.XCBuildConfiguration,
    [ids.debugBuildConfigurationId]: {
      isa: "XCBuildConfiguration",
      buildSettings,
      name: "Debug",
    },
    [`${ids.debugBuildConfigurationId}_comment`]: "Debug",
    [ids.releaseBuildConfigurationId]: {
      isa: "XCBuildConfiguration",
      buildSettings,
      name: "Release",
    },
    [`${ids.releaseBuildConfigurationId}_comment`]: "Release",
  };

  xcodeProject.objects.XCConfigurationList = {
    ...xcodeProject.objects.XCConfigurationList,
    [ids.buildConfigurationListId]: {
      isa: "XCConfigurationList",
      buildConfigurations: [
        {
          value: ids.debugBuildConfigurationId,
          comment: "Debug",
        },
        {
          value: ids.releaseBuildConfigurationId,
          comment: "Release",
        },
      ],
      defaultConfigurationIsVisible: 0,
      defaultConfigurationName: "Release",
    },
    [`${ids.buildConfigurationListId}_comment`]: `Build configuration list for PBXNativeTarget "${name}"`,
  };

  const project = xcodeProject.objects.PBXProject?.[options.projectObjectId];
  if (project && typeof project !== "string") {
    project.targets = [
      ...(project.targets ?? []),
      {
        value: ids.targetId,
        comment: name,
      },
    ];
  }

  const productsGroup =
    xcodeProject.objects.PBXGroup?.[options.productsGroupId];
  if (productsGroup && typeof productsGroup !== "string") {
    productsGroup.children = [
      ...(productsGroup.children ?? []),
      {
        value: ids.productReferenceId,
        comment: `${name}.xctest`,
      },
    ];
  }

  return ids;
}

export function hostedTestTargetFixtureIds(
  name: string,
): HostedTestTargetFixtureIds {
  const idPrefix = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return {
    targetId: `${idPrefix}000000000000000001`,
    frameworksBuildPhaseId: `${idPrefix}000000000000000002`,
    debugBuildConfigurationId: `${idPrefix}000000000000000003`,
    releaseBuildConfigurationId: `${idPrefix}000000000000000004`,
    buildConfigurationListId: `${idPrefix}000000000000000005`,
    productReferenceId: `${idPrefix}000000000000000006`,
  };
}

function hostedUnitTestBuildSettings({
  bundleLoader,
  hostAppName,
  name,
  testHost,
}: {
  bundleLoader?: string | undefined;
  hostAppName: string;
  name: string;
  testHost?: string | undefined;
}): Record<string, string> {
  return {
    BUNDLE_LOADER: bundleLoader ?? '"$(TEST_HOST)"',
    PRODUCT_BUNDLE_IDENTIFIER: `com.getsentry.${name}`,
    PRODUCT_NAME: '"$(TARGET_NAME)"',
    TEST_HOST:
      testHost ??
      `"$(BUILT_PRODUCTS_DIR)/${hostAppName}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/${hostAppName}"`,
  };
}
