/**
 * Read and change an Xcode project (`project.pbxproj`) through the `xcode`
 * package: targets, build settings, Swift packages, build phases, and the
 * files each target compiles.
 */

import { clack } from "../utils/clack/prompts.js";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lt, valid } from "semver";
import { debug } from "../utils/debug.js";
import type { SentryProjectData } from "../utils/types.js";
import {
  getRunScriptTemplate,
  isSentryUploadScript,
  scriptInputPath,
} from "./templates.js";

import {
  project as createXcodeProject,
  type PBXFileReference,
  type PBXFileSystemSynchronizedBuildFileExceptionSet,
  type PBXSourcesBuildPhase,
  type PBXFileSystemSynchronizedRootGroup,
  type PBXGroup,
  type PBXNativeTarget,
  type PBXObjects,
  type PBXShellScriptBuildPhase,
  type Project,
  type XCConfigurationList,
} from "xcode";
import { MacOSSystemHelpers } from "./macos-system-helper.js";
import { type XcodeProjectObjectWithId } from "./xcode-project-object-with-id.js";

interface ProjectFile {
  key?: string | undefined;
  name: string;
  path: string;
}

export type SwiftPackageSpec = {
  repositoryURL: string;
  requirement: {
    kind: "upToNextMajorVersion";
    minimumVersion: string;
  };
  commentName: string;
};

export type SwiftPackageProductSpec = {
  package: SwiftPackageSpec;
  productName: string;
};

const XCODE_APPLICATION_PRODUCT_TYPE = "com.apple.product-type.application";
const XCODE_UNIT_TEST_PRODUCT_TYPE = "com.apple.product-type.bundle.unit-test";

function unquote(value: unknown): string {
  return typeof value === "string" ? value.replace(/"/g, "") : "";
}

/**
 * `value` as a quoted `project.pbxproj` string. Backslashes are escaped
 * before quotes, so a backslash in `value` can't end the string early.
 */
function quotePbxString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stripAppExtension(value: string | undefined): string | undefined {
  return value?.endsWith(".app") ? value.slice(0, -".app".length) : value;
}

function resolveBuildSettingValue(
  value: unknown,
  targetName: string,
): string | undefined {
  const resolvedValue = unquote(value)
    .replace(/\$\(TARGET_NAME\)/g, targetName)
    .replace(/\$\{TARGET_NAME\}/g, targetName)
    .trim();

  return resolvedValue && !resolvedValue.includes("$")
    ? resolvedValue
    : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter(Boolean))] as string[];
}

function testHostReferencesApplication(
  testHost: unknown,
  appHostCandidates: ApplicationHostCandidates,
): boolean {
  const resolvedTestHost = unquote(testHost);
  if (!resolvedTestHost) {
    return false;
  }

  const referencesAppBundle = appHostCandidates.bundleNames.some((bundleName) =>
    containsPathSegment(resolvedTestHost, `${bundleName}.app`),
  );
  if (!referencesAppBundle) {
    return false;
  }

  return appHostCandidates.executableNames.some((executableName) =>
    containsPathSegment(resolvedTestHost, executableName),
  );
}

function containsPathSegment(value: string, segment: string): boolean {
  return new RegExp(`(^|/)${escapeRegExp(segment)}(/|$)`).test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSwiftPackageRepositoryURL(value: unknown): string {
  return unquote(value).replace(/\/+$/, "");
}

function shouldUpdatePackageRequirement(
  existingRequirement: unknown,
  requestedRequirement: SwiftPackageSpec["requirement"],
): boolean {
  if (!existingRequirement || typeof existingRequirement !== "object") {
    return true;
  }

  const requirement = existingRequirement as Record<string, unknown>;
  if (requirement["kind"] !== requestedRequirement.kind) {
    return true;
  }

  const existingMinimumVersion = requirement["minimumVersion"];
  if (typeof existingMinimumVersion !== "string") {
    return true;
  }

  const existingVersion = valid(existingMinimumVersion);
  const requestedVersion = valid(requestedRequirement.minimumVersion);
  if (!existingVersion || !requestedVersion) {
    return existingMinimumVersion !== requestedRequirement.minimumVersion;
  }

  return lt(existingVersion, requestedVersion);
}

function setDebugInformationFormatAndSandbox(
  proj: Project,
  targetName: string,
): void {
  const xcObjects = proj.hash.project.objects;
  if (!xcObjects.PBXNativeTarget) {
    xcObjects.PBXNativeTarget = {};
  }
  const targetKey = Object.keys(xcObjects.PBXNativeTarget).find((key) => {
    const value = xcObjects.PBXNativeTarget?.[key];
    return (
      !key.endsWith("_comment") &&
      typeof value !== "string" &&
      value?.name === targetName
    );
  });
  const target =
    targetKey === undefined
      ? undefined
      : (xcObjects.PBXNativeTarget[targetKey] as PBXNativeTarget | undefined);

  if (!xcObjects.XCBuildConfiguration) {
    xcObjects.XCBuildConfiguration = {};
  }
  if (!xcObjects.XCConfigurationList) {
    xcObjects.XCConfigurationList = {};
  }
  const buildConfigurationListId = target?.buildConfigurationList ?? "";
  const configurationList = xcObjects.XCConfigurationList[
    buildConfigurationListId
  ] as XCConfigurationList | undefined;
  const buildListConfigurationIds =
    configurationList?.buildConfigurations ?? [];
  for (const buildListConfigId of buildListConfigurationIds) {
    const config = xcObjects.XCBuildConfiguration[buildListConfigId.value];
    if (config === undefined || typeof config === "string") {
      // Ignore comments
      continue;
    }

    const buildSettings = config.buildSettings ?? {};
    buildSettings["DEBUG_INFORMATION_FORMAT"] = '"dwarf-with-dsym"';
    buildSettings["ENABLE_USER_SCRIPT_SANDBOXING"] = '"NO"';

    config.buildSettings = buildSettings;
    xcObjects.XCBuildConfiguration[buildListConfigId.value] = config;
  }
}

export type SwiftPackageProductLinkOptions = {
  product: SwiftPackageProductSpec;
  existingFrameworkComment?: string | undefined;
  successMessage?: string | undefined;
};

type ApplicationHostCandidates = {
  bundleNames: string[];
  executableNames: string[];
};

export class XcodeProject {
  /**
   * The directory where the Xcode project is located.
   */
  baseDir: string;

  /**
   * The path to the `<PROJECT>.xcodeproj` directory.
   */
  xcodeprojPath: string;

  /**
   * The path to the `project.pbxproj` file.
   */
  pbxprojPath: string;

  /**
   * The Xcode project object.
   */
  project: Project;

  objects: PBXObjects;

  /**
   * Creates a new XcodeProject instance, a wrapper around the Xcode project file `<PROJECT>.xcodeproj/project.pbxproj`.
   *
   * @param projectPath - The path to the Xcode project file
   */
  public constructor(projectPath: string) {
    this.pbxprojPath = projectPath;
    this.xcodeprojPath = path.dirname(projectPath);
    this.baseDir = path.dirname(this.xcodeprojPath);

    this.project = createXcodeProject(projectPath);
    this.project.parseSync();
    this.objects = this.project.hash.project.objects;
  }

  public getAllTargets(): string[] {
    const targets = this.objects.PBXNativeTarget ?? {};
    return Object.keys(targets)
      .filter((key) => {
        const value = targets[key];
        return (
          !key.endsWith("_comment") &&
          value !== undefined &&
          typeof value !== "string" &&
          unquote(value.productType).startsWith(XCODE_APPLICATION_PRODUCT_TYPE)
        );
      })
      .map((key) => {
        return (targets[key] as PBXNativeTarget).name;
      });
  }

  public getUnitTestTargetNames(): string[] {
    const targets = this.objects.PBXNativeTarget ?? {};
    return Object.keys(targets)
      .filter((key) => {
        const value = targets[key];
        return this.isUnitTestTargetEntry(key, value);
      })
      .map((key) => {
        return (targets[key] as PBXNativeTarget).name;
      });
  }

  public getHostedUnitTestTargetNames(): string[] {
    const targets = this.objects.PBXNativeTarget ?? {};
    return Object.keys(targets)
      .filter((key) => {
        const value = targets[key];
        return (
          this.isUnitTestTargetEntry(key, value) &&
          this.getTargetBuildSettings(value).some((buildSettings) =>
            Boolean(unquote(buildSettings["TEST_HOST"]).trim()),
          )
        );
      })
      .map((key) => {
        return (targets[key] as PBXNativeTarget).name;
      });
  }

  public getHostedUnitTestTargetNamesForApplicationTarget(
    appTargetName: string,
  ): string[] {
    const appTarget = this.findNativeTargetByName(appTargetName);
    if (!appTarget) {
      return [];
    }

    const appHostCandidates = this.getApplicationHostCandidates(appTarget);
    const targets = this.objects.PBXNativeTarget ?? {};
    return Object.keys(targets)
      .filter((key) => {
        const value = targets[key];
        return (
          !key.endsWith("_comment") &&
          value !== undefined &&
          typeof value !== "string" &&
          unquote(value.productType) === XCODE_UNIT_TEST_PRODUCT_TYPE &&
          this.getTargetBuildSettings(value).some((buildSettings) =>
            testHostReferencesApplication(
              buildSettings["TEST_HOST"],
              appHostCandidates,
            ),
          )
        );
      })
      .map((key) => {
        return (targets[key] as PBXNativeTarget).name;
      });
  }

  public getBundleIdentifierForTarget(targetName: string): string | undefined {
    const target = this.findNativeTargetByName(targetName);
    if (!target) {
      return undefined;
    }

    return this.getTargetBuildSettings(target.obj)
      .map((buildSettings) => {
        return unquote(buildSettings["PRODUCT_BUNDLE_IDENTIFIER"]);
      })
      .find(Boolean);
  }

  /**
   * Idempotently links a Swift package product to one target dependency list
   * and Frameworks build phase. Returns whether the pbxproj graph changed and
   * whether the product is linked after the operation.
   */
  public ensureSwiftPackageProductLinked(
    targetName: string,
    product: SwiftPackageProductSpec,
  ): { changed: boolean; linked: boolean } {
    const target = this.findNativeTargetByName(targetName);
    if (!target) {
      debug(`Target not found: ${targetName}`);
      return { changed: false, linked: false };
    }

    const frameworksBuildPhase = this.findFrameworksBuildPhaseInTarget(
      target.obj,
    );
    if (!frameworksBuildPhase) {
      debug(`Frameworks build phase not found for target: ${targetName}`);
      return { changed: false, linked: false };
    }

    let changed = false;

    // Ensure the remote Swift package object exists.
    const packageReference = this.ensureSwiftPackageReference(product.package);
    changed = packageReference.changed || changed;

    // Attach the Swift package object to the root Xcode project.
    changed =
      this.ensureProjectSwiftPackageReference(
        packageReference.packageRefId,
        product.package.commentName,
      ) || changed;

    // Ensure the package product dependency object exists.
    const productDependency = this.ensureSwiftPackageProductDependency(
      packageReference.packageRefId,
      product,
    );
    changed = productDependency.changed || changed;

    if (!target.obj.packageProductDependencies) {
      target.obj.packageProductDependencies = [];
    }

    // Attach the package product dependency to the selected target.
    if (
      !target.obj.packageProductDependencies.some((dependency) => {
        return dependency.value === productDependency.productDependencyId;
      })
    ) {
      target.obj.packageProductDependencies.push({
        value: productDependency.productDependencyId,
        comment: product.productName,
      });
      changed = true;
    }

    // Link the package product in the target Frameworks build phase.
    changed =
      this.ensureFrameworksBuildFile(
        frameworksBuildPhase,
        productDependency.productDependencyId,
        product,
      ) || changed;

    return { changed, linked: true };
  }

  public updateXcodeProject(
    sentryProject: SentryProjectData,
    target: string,
    swiftPackageProduct?: SwiftPackageProductLinkOptions,
    uploadSource = true,
  ): void {
    this.addUploadSymbolsScript({
      sentryProject,
      targetName: target,
      uploadSource,
    });
    if (uploadSource) {
      setDebugInformationFormatAndSandbox(this.project, target);
    }
    if (
      swiftPackageProduct &&
      !(
        swiftPackageProduct.existingFrameworkComment &&
        this.hasFrameworkBuildFileCommentInTarget(
          target,
          swiftPackageProduct.existingFrameworkComment,
        )
      )
    ) {
      const result = this.ensureSwiftPackageProductLinked(
        target,
        swiftPackageProduct.product,
      );
      if (result.changed && swiftPackageProduct.successMessage) {
        clack.log.step(swiftPackageProduct.successMessage);
      }
    }
    this.write();
  }

  addUploadSymbolsScript({
    sentryProject,
    targetName,
    uploadSource,
  }: {
    sentryProject: SentryProjectData;
    targetName: string;
    uploadSource: boolean;
  }): void {
    const xcObjects = this.project.hash.project.objects;
    if (!xcObjects.PBXNativeTarget) {
      xcObjects.PBXNativeTarget = {};
    }
    const targetKey = Object.keys(xcObjects.PBXNativeTarget).find((key) => {
      const value = xcObjects.PBXNativeTarget?.[key];
      return (
        !key.endsWith("_comment") &&
        typeof value !== "string" &&
        value?.name === targetName
      );
    });
    const target =
      targetKey === undefined
        ? undefined
        : (xcObjects.PBXNativeTarget[targetKey] as PBXNativeTarget | undefined);
    if (!target || targetKey === undefined) {
      debug(`Target not found: ${targetName}`);
      return;
    }

    // Generate the new script content
    const shellScript = getRunScriptTemplate(
      sentryProject.organization.slug,
      sentryProject.slug,
      uploadSource,
    );

    if (!xcObjects.PBXShellScriptBuildPhase) {
      xcObjects.PBXShellScriptBuildPhase = {};
    }

    // Look for existing Sentry build phase in the current target
    let existingSentryBuildPhaseId: string | undefined;
    let existingSentryBuildPhase: PBXShellScriptBuildPhase | undefined;

    // Check target's build phases for an existing Sentry upload script, from this wizard or an older sentry-cli one
    if (target.buildPhases) {
      for (const phase of target.buildPhases) {
        const buildPhase = xcObjects.PBXShellScriptBuildPhase[phase.value];
        if (
          typeof buildPhase === "object" &&
          buildPhase.shellScript !== undefined &&
          isSentryUploadScript(buildPhase.shellScript)
        ) {
          existingSentryBuildPhaseId = phase.value;
          existingSentryBuildPhase = buildPhase;
          break;
        }
      }
    }

    // Clean up orphaned build phase references that may exist from previous runs
    // Find all build phase IDs that are referenced in targets but don't exist in PBXShellScriptBuildPhase
    const orphanedBuildPhaseIds: string[] = [];
    for (const targetKey in xcObjects.PBXNativeTarget) {
      const targetValue = xcObjects.PBXNativeTarget[targetKey];
      if (typeof targetValue === "object" && targetValue.buildPhases) {
        for (const phase of targetValue.buildPhases) {
          // Check if this is a shell script build phase that doesn't exist
          if (
            !xcObjects.PBXShellScriptBuildPhase[phase.value] &&
            phase.comment?.includes("Upload Debug Symbols to Sentry")
          ) {
            orphanedBuildPhaseIds.push(phase.value);
          }
        }
      }
    }

    // Remove orphaned build phase references from all targets
    if (orphanedBuildPhaseIds.length > 0) {
      for (const targetKey in xcObjects.PBXNativeTarget) {
        const targetValue = xcObjects.PBXNativeTarget[targetKey];
        if (typeof targetValue === "object" && targetValue.buildPhases) {
          targetValue.buildPhases = targetValue.buildPhases.filter((phase) => {
            return !orphanedBuildPhaseIds.includes(phase.value);
          });
        }
      }
    }

    if (existingSentryBuildPhaseId && existingSentryBuildPhase) {
      // Update existing build phase instead of adding a new one
      // This call is idempotent, so it will not add a new build phase if it already exists
      this.updateScriptBuildPhase(existingSentryBuildPhaseId, shellScript, [
        scriptInputPath,
      ]);
      clack.log.step(
        `Updated existing Sentry upload script for "${targetName}" build phase`,
      );
    } else {
      // Add new build phase to the target
      this.addScriptBuildPhase(
        targetKey,
        "Upload Debug Symbols to Sentry",
        shellScript,
        [scriptInputPath],
      );
      clack.log.step(
        `Added Sentry upload script to "${targetName}" build phase`,
      );
    }
  }

  public write(): void {
    const newContent = this.project.writeSync();
    writeFileSync(this.pbxprojPath, newContent);
  }

  public getSynchronizedRootGroupPathsForTarget(targetName: string): string[] {
    const nativeTarget = this.findNativeTargetByName(targetName);
    if (!nativeTarget) {
      return [];
    }

    return (nativeTarget.obj.fileSystemSynchronizedGroups ?? []).reduce(
      (groupPaths, group) => {
        const groupObj =
          this.objects.PBXFileSystemSynchronizedRootGroup?.[group.value];
        if (!groupObj || typeof groupObj !== "object") {
          return groupPaths;
        }

        const groupPath = this.resolveAbsolutePathOfSynchronizedRootGroup({
          id: group.value,
          obj: groupObj,
        });
        if (!groupPath) {
          return groupPaths;
        }

        return [...groupPaths, groupPath];
      },
      new Array<string>(),
    );
  }

  /**
   * Ensures a Swift file is compiled by a target, either through an Xcode
   * synchronized root group or an explicit Sources build phase entry.
   */
  public addSwiftSourceFileToTarget(args: {
    targetName: string;
    filePath: string;
  }): { changed: boolean; included: boolean } {
    const nativeTarget = this.findNativeTargetByName(args.targetName);
    const defaultResult = { changed: false, included: false };
    if (!nativeTarget) {
      debug(`Target not found: ${args.targetName}`);
      return defaultResult;
    }

    const absoluteFilePath = args.filePath;
    if (
      this.isFileIncludedBySynchronizedRootGroup(nativeTarget, absoluteFilePath)
    ) {
      return {
        changed: false,
        included: true,
      };
    }

    const sourceBuildPhase = this.findSourceBuildPhaseInTarget(
      nativeTarget.obj,
    );
    if (!sourceBuildPhase) {
      debug(`Sources build phase not found for target: ${args.targetName}`);
      return defaultResult;
    }

    const fileReference = this.ensureSwiftFileReference(absoluteFilePath);
    const sourceBuildPhaseFiles = sourceBuildPhase.obj.files ?? [];
    const existingBuildFileReference = sourceBuildPhaseFiles.find((file) => {
      const buildFile = this.objects.PBXBuildFile?.[file.value];
      return (
        buildFile &&
        typeof buildFile !== "string" &&
        buildFile.fileRef === fileReference.fileReferenceId
      );
    });

    if (existingBuildFileReference) {
      return {
        changed: fileReference.changed,
        included: true,
      };
    }

    if (!this.objects.PBXBuildFile) {
      this.objects.PBXBuildFile = {};
    }

    const buildFileId = this.project.generateUuid();
    const fileName = path.basename(absoluteFilePath);
    this.objects.PBXBuildFile[buildFileId] = {
      isa: "PBXBuildFile",
      fileRef: fileReference.fileReferenceId,
      fileRef_comment: fileName,
    };
    this.objects.PBXBuildFile[`${buildFileId}_comment`] =
      `${fileName} in Sources`;

    sourceBuildPhase.obj.files = [
      ...sourceBuildPhaseFiles,
      {
        value: buildFileId,
        comment: `${fileName} in Sources`,
      },
    ];

    return { changed: true, included: true };
  }

  /**
   * Retrieves all source files associated with a specific target in the Xcode project.
   * This is used to find files where we can inject Sentry initialization code.
   *
   * @param targetName - The name of the target to get files for
   * @returns An array of absolute file paths for the target's source files, or undefined if target not found
   */
  public getSourceFilesForTarget(targetName: string): string[] | undefined {
    // ## Summary how Xcode Projects are structured:
    // - Every Xcode Project has exactly one main group of type `PBXGroup`
    // - The main group contains a list of children identifiers
    // - Each child can be a `PBXGroup`, a `PBXFileReference` or a `PBXFileSystemSynchronizedRootGroup`
    // - Each `PBXGroup` has a list of children identifiers which again can be `PBXGroup`, `PBXFileReference` or `PBXFileSystemSynchronizedRootGroup`
    // - The target defines the list of `fileSystemSynchronizedGroups` which are `PBXFileSystemSynchronizedRootGroup` to be included in the build phase
    // - The `PBXFileSystemSynchronizedRootGroup` has a list of `exceptions` which are `PBXFileSystemSynchronizedBuildFileExceptionSet`
    // - Each `PBXFileSystemSynchronizedBuildFileExceptionSet` represents a folder to be excluded from the build.
    // - The `PBXFileSystemSynchronizedBuildFileExceptionSet` has a list of `membershipExceptions` which are files to be excluded from being excluded, therefore included in the build.
    // - The Xcode project has a build phase `PBXSourcesBuildPhase` which has a list of `files` which are `PBXBuildFile`
    // - A file which is not part of a `PBXFileSystemSynchronizedRootGroup` must be added to the `files` list of the `PBXSourcesBuildPhase` build phase
    // - Nested subfolders in `fileSystemSynchronizedGroups` are not declared but recursively included
    //
    // Based on the findings above the files included in the build phase are:
    // - All files in the `files` of the `PBXSourcesBuildPhase` build phase `Sources` of the target
    // - All files in directories of the `fileSystemSynchronizedGroups` of the target
    // - Excluding all files in the `exceptions` of the `PBXFileSystemSynchronizedRootGroup` of the target
    // - Including all files in the `membershipExceptions` of the `PBXFileSystemSynchronizedBuildFileExceptionSet` of the target
    const nativeTarget = this.findNativeTargetByName(targetName);
    if (!nativeTarget) {
      debug("Target not found: " + targetName);
      return undefined;
    }

    const filesInBuildPhase = this.findFilesInSourceBuildPhase(nativeTarget);
    debug(
      `Found ${filesInBuildPhase.length} files in build phase for target: ${targetName}`,
    );

    const filesInSynchronizedRootGroups =
      this.findFilesInSynchronizedRootGroups(nativeTarget);
    debug(
      `Found ${filesInSynchronizedRootGroups.length} files in synchronized root groups for target: ${targetName}`,
    );
    return [...filesInBuildPhase, ...filesInSynchronizedRootGroups];
  }

  private isUnitTestTargetEntry(
    key: string,
    value: PBXNativeTarget | string | undefined,
  ): value is PBXNativeTarget {
    return (
      !key.endsWith("_comment") &&
      typeof value !== "string" &&
      value !== undefined &&
      unquote(value.productType) === XCODE_UNIT_TEST_PRODUCT_TYPE
    );
  }

  private getTargetBuildSettings(
    target: PBXNativeTarget,
  ): Record<string, unknown>[] {
    const buildConfigurationListId = target.buildConfigurationList;
    if (!buildConfigurationListId) {
      return [];
    }

    const configurationList = this.objects.XCConfigurationList?.[
      buildConfigurationListId
    ] as XCConfigurationList | undefined;
    if (!configurationList || typeof configurationList === "string") {
      return [];
    }

    return (configurationList.buildConfigurations ?? []).reduce(
      (buildSettings, buildConfiguration) => {
        const configuration =
          this.objects.XCBuildConfiguration?.[buildConfiguration.value];
        if (!configuration || typeof configuration === "string") {
          return buildSettings;
        }

        return [...buildSettings, configuration.buildSettings ?? {}];
      },
      new Array<Record<string, unknown>>(),
    );
  }

  private getApplicationHostCandidates(
    target: XcodeProjectObjectWithId<PBXNativeTarget>,
  ): ApplicationHostCandidates {
    const buildSettings = this.getTargetBuildSettings(target.obj);
    const productReferencePath = this.getProductReferencePath(target.obj);
    const productReferenceName = stripAppExtension(productReferencePath);
    const targetProductName = resolveBuildSettingValue(
      target.obj.productName,
      target.obj.name,
    );
    const buildSettingProductNames = buildSettings.flatMap((settings) => [
      resolveBuildSettingValue(settings["PRODUCT_NAME"], target.obj.name),
      stripAppExtension(
        resolveBuildSettingValue(
          settings["FULL_PRODUCT_NAME"],
          target.obj.name,
        ),
      ),
      stripAppExtension(
        resolveBuildSettingValue(settings["WRAPPER_NAME"], target.obj.name),
      ),
    ]);
    const buildSettingExecutableNames = buildSettings.map((settings) =>
      resolveBuildSettingValue(settings["EXECUTABLE_NAME"], target.obj.name),
    );

    return {
      bundleNames: uniqueStrings([
        target.obj.name,
        targetProductName,
        productReferenceName,
        ...buildSettingProductNames,
      ]),
      executableNames: uniqueStrings([
        target.obj.name,
        targetProductName,
        productReferenceName,
        ...buildSettingExecutableNames,
      ]),
    };
  }

  private getProductReferencePath(target: PBXNativeTarget): string | undefined {
    if (!target.productReference) {
      return undefined;
    }

    const productReference =
      this.objects.PBXFileReference?.[target.productReference];
    if (!productReference || typeof productReference === "string") {
      return undefined;
    }

    return unquote(productReference.path);
  }

  private hasFrameworkBuildFileCommentInTarget(
    targetName: string,
    comment: string,
  ): boolean {
    const target = this.findNativeTargetByName(targetName);
    if (!target) {
      return false;
    }

    const frameworksBuildPhase = this.findFrameworksBuildPhaseInTarget(
      target.obj,
    );
    return (frameworksBuildPhase?.files ?? []).some((framework) => {
      return framework.comment === comment;
    });
  }

  private ensureSwiftPackageReference(packageSpec: SwiftPackageSpec): {
    packageRefId: string;
    changed: boolean;
  } {
    if (!this.objects.XCRemoteSwiftPackageReference) {
      this.objects.XCRemoteSwiftPackageReference = {};
    }

    const packageReferences = this.objects
      .XCRemoteSwiftPackageReference as Record<string, unknown>;
    const requestedRepositoryURL = normalizeSwiftPackageRepositoryURL(
      packageSpec.repositoryURL,
    );
    const existingPackageReference = Object.entries(packageReferences).find(
      ([id, value]) => {
        if (id.endsWith("_comment") || typeof value !== "object") {
          return false;
        }

        const packageReference = value as Record<string, unknown>;
        return (
          normalizeSwiftPackageRepositoryURL(
            packageReference["repositoryURL"],
          ) === requestedRepositoryURL
        );
      },
    );

    if (existingPackageReference) {
      const packageReference = existingPackageReference[1] as Record<
        string,
        unknown
      >;
      if (
        shouldUpdatePackageRequirement(
          packageReference["requirement"],
          packageSpec.requirement,
        )
      ) {
        packageReference["requirement"] = packageSpec.requirement;
        return { packageRefId: existingPackageReference[0], changed: true };
      }

      return { packageRefId: existingPackageReference[0], changed: false };
    }

    const packageRefId = this.project.generateUuid();
    packageReferences[packageRefId] = {
      isa: "XCRemoteSwiftPackageReference",
      repositoryURL: `"${packageSpec.repositoryURL}"`,
      requirement: packageSpec.requirement,
    };
    packageReferences[`${packageRefId}_comment`] =
      this.swiftPackageReferenceComment(packageSpec.commentName);

    return { packageRefId, changed: true };
  }

  private ensureProjectSwiftPackageReference(
    packageRefId: string,
    commentName: string,
  ): boolean {
    const xcodeProject = this.project.getFirstProject().firstProject as {
      packageReferences?: { value: string; comment?: string }[];
    };
    if (!xcodeProject.packageReferences) {
      xcodeProject.packageReferences = [];
    }

    if (
      xcodeProject.packageReferences.some((packageReference) => {
        return packageReference.value === packageRefId;
      })
    ) {
      return false;
    }

    xcodeProject.packageReferences.push({
      value: packageRefId,
      comment: this.swiftPackageReferenceComment(commentName),
    });
    return true;
  }

  private ensureSwiftPackageProductDependency(
    packageRefId: string,
    product: SwiftPackageProductSpec,
  ): { productDependencyId: string; changed: boolean } {
    if (!this.objects.XCSwiftPackageProductDependency) {
      this.objects.XCSwiftPackageProductDependency = {};
    }

    const productDependencies = this.objects
      .XCSwiftPackageProductDependency as Record<string, unknown>;
    const existingProductDependency = Object.entries(productDependencies).find(
      ([id, value]) => {
        if (id.endsWith("_comment") || typeof value !== "object") {
          return false;
        }

        const productDependency = value as Record<string, unknown>;
        return (
          productDependency["package"] === packageRefId &&
          unquote(productDependency["productName"]) === product.productName
        );
      },
    );

    if (existingProductDependency) {
      return {
        productDependencyId: existingProductDependency[0],
        changed: false,
      };
    }

    const productDependencyId = this.project.generateUuid();
    productDependencies[productDependencyId] = {
      isa: "XCSwiftPackageProductDependency",
      package: packageRefId,
      package_comment: this.swiftPackageReferenceComment(
        product.package.commentName,
      ),
      productName: product.productName,
    };
    productDependencies[`${productDependencyId}_comment`] = product.productName;

    return { productDependencyId, changed: true };
  }

  private ensureFrameworksBuildFile(
    frameworksBuildPhase: {
      files?: { value: string; comment?: string }[];
    },
    productDependencyId: string,
    product: SwiftPackageProductSpec,
  ): boolean {
    if (!this.objects.PBXBuildFile) {
      this.objects.PBXBuildFile = {};
    }

    const existingFrameworkEntry = (frameworksBuildPhase.files ?? []).find(
      (framework) => {
        const buildFile = this.objects.PBXBuildFile?.[framework.value];
        return (
          buildFile &&
          typeof buildFile !== "string" &&
          buildFile.productRef === productDependencyId
        );
      },
    );
    if (existingFrameworkEntry) {
      return false;
    }

    const buildFileId = this.project.generateUuid();
    this.objects.PBXBuildFile[buildFileId] = {
      isa: "PBXBuildFile",
      productRef: productDependencyId,
      productRef_comment: product.productName,
    };
    this.objects.PBXBuildFile[`${buildFileId}_comment`] =
      `${product.productName} in Frameworks`;

    if (!frameworksBuildPhase.files) {
      frameworksBuildPhase.files = [];
    }
    frameworksBuildPhase.files.push({
      value: buildFileId,
      comment: `${product.productName} in Frameworks`,
    });

    return true;
  }

  private findFrameworksBuildPhaseInTarget(target: PBXNativeTarget):
    | {
        files?: { value: string; comment?: string }[];
      }
    | undefined {
    for (const buildPhaseReference of target.buildPhases ?? []) {
      const buildPhase =
        this.objects.PBXFrameworksBuildPhase?.[buildPhaseReference.value];
      if (buildPhase && typeof buildPhase !== "string") {
        return buildPhase;
      }
    }

    return undefined;
  }

  private swiftPackageReferenceComment(commentName: string): string {
    return `XCRemoteSwiftPackageReference "${commentName}"`;
  }

  private isFileIncludedBySynchronizedRootGroup(
    nativeTarget: XcodeProjectObjectWithId<PBXNativeTarget>,
    absoluteFilePath: string,
  ): boolean {
    return this.findFilesInSynchronizedRootGroups(nativeTarget).some(
      (filePath) => filePath === absoluteFilePath,
    );
  }

  private ensureSwiftFileReference(absoluteFilePath: string): {
    fileReferenceId: string;
    changed: boolean;
  } {
    if (!this.objects.PBXFileReference) {
      this.objects.PBXFileReference = {};
    }

    const existingFileReference = Object.entries(
      this.objects.PBXFileReference,
    ).find(([id, fileReference]) => {
      if (id.endsWith("_comment") || typeof fileReference !== "object") {
        return false;
      }

      const resolvedFilePath = this.resolveAbsolutePathOfFileReference({
        id,
        obj: fileReference,
      });
      return resolvedFilePath === absoluteFilePath;
    });

    if (existingFileReference) {
      return { fileReferenceId: existingFileReference[0], changed: false };
    }

    const fileReferenceId = this.project.generateUuid();
    const fileName = path.basename(absoluteFilePath);
    const relativePath = path.relative(this.baseDir, absoluteFilePath);
    this.objects.PBXFileReference[fileReferenceId] = {
      isa: "PBXFileReference",
      lastKnownFileType: "sourcecode.swift",
      path: relativePath,
      sourceTree: "SOURCE_ROOT",
    };
    this.objects.PBXFileReference[`${fileReferenceId}_comment`] = fileName;

    this.addFileReferenceToBestGroup(
      fileReferenceId,
      fileName,
      absoluteFilePath,
    );

    return { fileReferenceId, changed: true };
  }

  private addFileReferenceToBestGroup(
    fileReferenceId: string,
    fileName: string,
    absoluteFilePath: string,
  ): void {
    const parentDirectory = path.dirname(absoluteFilePath);
    const parentGroup =
      this.groups.find((group) => {
        const groupPath = this.resolveAbsolutePathOfGroup(group);
        return groupPath === parentDirectory;
      }) ?? this.mainGroup;

    if (!parentGroup) {
      return;
    }

    if (!parentGroup.obj.children) {
      parentGroup.obj.children = [];
    }

    if (
      parentGroup.obj.children.some((child) => child.value === fileReferenceId)
    ) {
      return;
    }

    parentGroup.obj.children.push({
      value: fileReferenceId,
      comment: fileName,
    });
  }

  private get mainGroup(): XcodeProjectObjectWithId<PBXGroup> | undefined {
    const project = Object.entries(this.objects.PBXProject ?? {}).find(
      ([id, candidate]) => {
        return !id.endsWith("_comment") && typeof candidate === "object";
      },
    )?.[1];
    if (!project || typeof project !== "object") {
      return undefined;
    }

    const mainGroupId = (project as { mainGroup?: string }).mainGroup;
    if (!mainGroupId) {
      return undefined;
    }

    const mainGroup = this.objects.PBXGroup?.[mainGroupId];
    if (!mainGroup || typeof mainGroup !== "object") {
      return undefined;
    }

    return { id: mainGroupId, obj: mainGroup };
  }

  // ================================ TARGET HELPERS ================================

  /**
   * Finds a native target by name.
   *
   * @param targetName - The name of the target to find
   * @returns The native target, or undefined if the target is not found
   */
  private findNativeTargetByName(
    targetName: string,
  ): XcodeProjectObjectWithId<PBXNativeTarget> | undefined {
    debug("Finding native target by name: " + targetName);

    if (!this.objects.PBXNativeTarget) {
      debug("No native targets found");
      return undefined;
    }

    const nativeTargets = Object.entries(this.objects.PBXNativeTarget);
    for (const [key, target] of nativeTargets) {
      // Ignore comments
      if (key.endsWith("_comment") || typeof target === "string") {
        continue;
      }

      // Ignore targets that are not the target we are looking for
      if (target.name !== targetName) {
        continue;
      }
      debug("Found native target: " + targetName);
      return {
        id: key,
        obj: target,
      };
    }

    debug("Target not found: " + targetName);
    return undefined;
  }

  // ================================ BUILD PHASE HELPERS ================================

  /**
   * Finds the source build phase in a target.
   *
   * @param target - The target to find the source build phase in
   * @returns The source build phase, or undefined if the target is not found or has no source build phase
   */
  findSourceBuildPhaseInTarget(
    target: PBXNativeTarget,
  ): XcodeProjectObjectWithId<PBXSourcesBuildPhase> | undefined {
    debug(`Finding source build phase in target: ${target.name}`);
    if (!target.buildPhases) {
      debug("No build phases found for target: " + target.name);
      return undefined;
    }
    for (const phase of target.buildPhases) {
      const buildPhaseId = phase.value;
      const buildPhase = this.objects.PBXSourcesBuildPhase?.[buildPhaseId];
      if (typeof buildPhase !== "object") {
        // Ignore comments
        continue;
      }
      debug(
        `Found source build phase: ${buildPhaseId} for target: ${target.name}`,
      );
      return {
        id: buildPhaseId,
        obj: buildPhase,
      };
    }

    debug(`No source build phase found for target: ${target.name}`);
    return undefined;
  }

  /**
   * Adds a new script build phase to the specified target.
   *
   * @param targetKey - The key of the target to add the build phase to
   * @param name - The name of the build phase
   * @param script - The shell script content
   * @param inputPaths - Array of input paths for the script
   * @returns The UUID of the created build phase
   */
  addScriptBuildPhase(
    targetKey: string,
    name: string,
    script: string,
    inputPaths: string[] = [],
  ): string {
    const buildPhaseUuid = this.project.generateUuid();
    // Create the shell script build phase object
    const buildPhase = {
      isa: "PBXShellScriptBuildPhase" as const,
      buildActionMask: 2147483647,
      files: [],
      inputPaths,
      outputPaths: [],
      runOnlyForDeploymentPostprocessing: 0,
      shellPath: "/bin/sh",
      shellScript: quotePbxString(script),
      name: `"${name}"`,
    };

    // Add to PBXShellScriptBuildPhase section
    if (!this.objects.PBXShellScriptBuildPhase) {
      this.objects.PBXShellScriptBuildPhase = {};
    }
    this.objects.PBXShellScriptBuildPhase[buildPhaseUuid] = buildPhase;
    this.objects.PBXShellScriptBuildPhase[`${buildPhaseUuid}_comment`] = name;

    // Add to target's build phases
    const target = this.objects.PBXNativeTarget?.[targetKey] as
      | PBXNativeTarget
      | undefined;
    if (target?.buildPhases) {
      target.buildPhases.push({
        value: buildPhaseUuid,
        comment: name,
      });
    }

    return buildPhaseUuid;
  }

  /**
   * Updates an existing script build phase.
   *
   * @param buildPhaseId - The UUID of the build phase to update
   * @param script - The new shell script content
   * @param inputPaths - Array of input paths for the script
   */
  updateScriptBuildPhase(
    buildPhaseId: string,
    script: string,
    inputPaths: string[] = [],
  ): void {
    const buildPhase = this.objects.PBXShellScriptBuildPhase?.[buildPhaseId];
    if (!buildPhase || typeof buildPhase === "string") {
      debug(`Build phase not found: ${buildPhaseId}`);
      return;
    }

    buildPhase.shellScript = quotePbxString(script);
    buildPhase.inputPaths = inputPaths;
    buildPhase.shellPath = "/bin/sh";
  }

  // ================================ FILE HELPERS ================================

  /**
   * Finds all files in the source build phase of a target.
   *
   * @param nativeTarget - The target to find the files in
   * @returns The files in the source build phase of the target, or an empty array if the target is not found or has no source build phase
   */
  findFilesInSourceBuildPhase(
    nativeTarget: XcodeProjectObjectWithId<PBXNativeTarget>,
  ): string[] {
    debug(
      "Finding files in source build phase for target: " +
        nativeTarget.obj.name,
    );
    const buildPhase = this.findSourceBuildPhaseInTarget(nativeTarget.obj);
    if (!buildPhase) {
      debug(
        `Sources build phase not found for target: ${nativeTarget.obj.name}`,
      );
      return [];
    }
    const buildPhaseFiles = buildPhase.obj.files;
    if (!buildPhaseFiles) {
      debug(
        `No files found in sources build phase for target: ${nativeTarget.obj.name}`,
      );
      return [];
    }
    if (!this.objects.PBXBuildFile) {
      debug("PBXBuildFile is undefined");
      return [];
    }
    if (!this.objects.PBXFileReference) {
      debug("PBXFileReference is undefined");
      return [];
    }

    const result: string[] = [];
    for (const file of buildPhaseFiles) {
      debug(`Resolving build phase file: ${file.value}`);
      // Find the related build file object
      const buildFileObj = this.objects.PBXBuildFile[file.value];
      if (!buildFileObj || typeof buildFileObj !== "object") {
        debug(`Build file object not found for file: ${file.value}`);
        continue;
      }
      debug(`Build file object found for file: ${file.value}`);

      const buildFileRefId = buildFileObj.fileRef;
      if (!buildFileRefId) {
        debug(`File reference not found for file: ${file.value}`);
        continue;
      }
      debug(`Build file reference found for file: ${file.value}`);

      // Find the related file reference object
      const buildFile = this.objects.PBXFileReference[buildFileRefId];
      if (!buildFile || typeof buildFile !== "object") {
        debug(`File not found in file dictionary for file: ${file.value}`);
        continue;
      }
      debug(`Build file found in file dictionary for file: ${file.value}`);

      // Resolve the path of the file based on the `sourceTree` property
      const resolvedFilePath = this.resolveAbsolutePathOfFileReference({
        id: buildFileRefId,
        obj: buildFile,
      });
      if (!resolvedFilePath) {
        debug(`Failed to resolve file path for file: ${file.value}`);
        continue;
      }
      debug(`Resolved file ${file.value} to path: ${resolvedFilePath}`);

      result.push(resolvedFilePath);
    }

    debug(
      `Resolved ${result.length} files for target: ${nativeTarget.obj.name}`,
    );
    return result;
  }

  /**
   * Resolves the absolute path of a file reference.
   *
   * @param fileRef - The file reference to resolve the path of
   * @returns The absolute path of the file reference, or undefined if the file reference is not found or has no path
   */
  private resolveAbsolutePathOfFileReference(
    fileRef: XcodeProjectObjectWithId<PBXFileReference>,
  ): string | undefined {
    debug(
      `Resolving path of file reference: ${fileRef.id} with path: ${fileRef.obj.path}`,
    );
    // File path is expected to be set, therefore typing is non-nullable.
    // As the file is loaded from a project file, it is not guaranteed to be set,
    // therefore we treat it as optional.
    if (!fileRef.obj.path) {
      debug(`File reference path not found for file reference: ${fileRef.id}`);
      return undefined;
    }

    // File references are resolved based on the `sourceTree` property
    // which can have one of the following values:
    // - '<absolute>': The file path is absolute
    // - '<group>': The file path is relative to the parent group of the file reference
    // - 'BUILT_PRODUCTS_DIR': The file path is relative to the built products directory, i.e. the build output directory in derived data
    // - 'SOURCE_ROOT': The file path is relative to the source root, i.e. the directory where the Xcode project is located
    // - 'SDKROOT': The file path is relative to the SDK root, i.e. the directory where the SDK is installed
    // - 'DEVELOPER_DIR': The file path is relative to the developer directory, i.e. the directory where the Xcode command line tools are installed

    // The default is '<group>'
    const fileRefSourceTree = fileRef.obj.sourceTree?.replace(/"/g, "") ?? "";
    switch (fileRefSourceTree) {
      case "<absolute>":
        return fileRef.obj.path.replace(/"/g, "");
      case "<group>":
        return this.resolveAbsoluteFilePathRelativeToGroup(fileRef);
      case "BUILT_PRODUCTS_DIR":
        return this.resolveAbsoluteFilePathRelativeToBuiltProductsDir(fileRef);
      case "SOURCE_ROOT":
        return this.resolveAbsoluteFilePathRelativeToSourceRoot(fileRef);
      case "SDKROOT":
        return this.resolveAbsoluteFilePathRelativeToSdkRoot(fileRef);
      case "DEVELOPER_DIR":
        return this.resolveAbsoluteFilePathRelativeToDeveloperDir(fileRef);
      default:
        debug(
          `Unknown source tree '${fileRef.obj.sourceTree}' for build file: ${fileRef.obj.path}`,
        );
        return undefined;
    }
  }

  /**
   * Resolves the absolute path of a file reference relative to the parent group.
   *
   * @param fileRef - The file reference to resolve the path of
   * @returns The absolute path of the file reference, or undefined if the file reference is not found or has no path
   */
  private resolveAbsoluteFilePathRelativeToGroup(
    fileRef: XcodeProjectObjectWithId<PBXFileReference>,
  ): string | undefined {
    debug(
      `Resolving absolute file path relative to group for file reference: ${
        fileRef.id
      } with path: ${fileRef.obj.path ?? ""}`,
    );
    const fileRefPath = fileRef.obj.path?.replace(/"/g, "");
    if (!fileRefPath) {
      debug(`File reference path not found for file reference: ${fileRef.id}`);
      return undefined;
    }

    // Find the parent group of the file reference by searching for the reverse relationship
    const parentGroup = this.findParentGroupByChildId(fileRef.id);
    if (!parentGroup) {
      debug(
        `Parent group not found for file reference: ${fileRef.id} at path: ${fileRefPath}`,
      );
      return undefined;
    }

    // Resolve the path of the parent group
    const absoluteGroupPath = this.resolveAbsolutePathOfGroup(parentGroup);
    if (!absoluteGroupPath) {
      debug(`Failed to resolve path of group: ${parentGroup.id}`);
      return undefined;
    }

    return path.join(absoluteGroupPath, fileRefPath);
  }

  /**
   * Resolves the absolute path of a file reference relative to the built products directory.
   *
   * @param buildFile - The file reference to resolve the path of
   * @returns The absolute path of the file reference, or undefined if the file reference is not found or has no path
   */
  private resolveAbsoluteFilePathRelativeToBuiltProductsDir(
    buildFile: XcodeProjectObjectWithId<PBXFileReference>,
  ): string | undefined {
    debug(
      `Resolving absolute file path relative to built products directory for file reference: ${
        buildFile.id
      } with path: ${buildFile.obj.path ?? ""}`,
    );
    const builtProductsDir = this.getBuildProductsDirectoryPath();
    if (!builtProductsDir) {
      debug(`Failed to resolve built products directory path`);
      return undefined;
    }

    return path.join(
      builtProductsDir,
      (buildFile.obj.path ?? "").replace(/"/g, ""),
    );
  }

  /**
   * Resolves the absolute path of a file reference relative to the source root.
   *
   * The source root is the directory where the `.xcodeproj` file is located.
   *
   * @param buildFile - The file reference to resolve the path of
   * @returns The absolute path of the file reference, or undefined if the file reference is not found or has no path
   */
  private resolveAbsoluteFilePathRelativeToSourceRoot(
    buildFile: XcodeProjectObjectWithId<PBXFileReference>,
  ): string | undefined {
    return path.join(
      this.baseDir,
      (buildFile.obj.path ?? "").replace(/"/g, ""),
    );
  }

  /**
   * Resolves the absolute path of a file reference relative to the SDK root.
   *
   * @param buildFile - The file reference to resolve the path of
   * @returns The absolute path of the file reference, or undefined if the file reference is not found or has no path
   */
  private resolveAbsoluteFilePathRelativeToSdkRoot(
    buildFile: XcodeProjectObjectWithId<PBXFileReference>,
  ): string | undefined {
    debug(
      `Resolving absolute file path relative to SDK root for file reference: ${
        buildFile.id
      } with path: ${buildFile.obj.path ?? ""}`,
    );

    const sdkRoot = MacOSSystemHelpers.findSDKRootDirectoryPath();
    if (!sdkRoot) {
      debug(`Failed to resolve SDK root directory path`);
      return undefined;
    }

    return path.join(sdkRoot, (buildFile.obj.path ?? "").replace(/"/g, ""));
  }

  /**
   * Resolves the absolute path of a file reference relative to the developer directory.
   *
   * @param buildFile - The file reference to resolve the path of
   * @returns The absolute path of the file reference, or undefined if the file reference is not found or has no path
   */
  private resolveAbsoluteFilePathRelativeToDeveloperDir(
    buildFile: XcodeProjectObjectWithId<PBXFileReference>,
  ): string | undefined {
    debug(
      `Resolving absolute file path relative to developer directory for file reference: ${
        buildFile.id
      } with path: ${buildFile.obj.path ?? ""}`,
    );
    const developerDir = MacOSSystemHelpers.findDeveloperDirectoryPath();
    if (!developerDir) {
      debug(`Failed to resolve developer directory path`);
      return undefined;
    }

    return path.join(
      developerDir,
      (buildFile.obj.path ?? "").replace(/"/g, ""),
    );
  }

  /**
   * Resolves the absolute path of a group.
   *
   * @param group - The group to resolve the path of
   * @returns The absolute path of the group, or undefined if the group is not found or has no path
   */
  private resolveAbsolutePathOfGroup(
    group: XcodeProjectObjectWithId<PBXGroup>,
  ): string | undefined {
    debug(
      `Resolving path of group: ${group.id} with path: ${group.obj.path ?? ""}`,
    );

    // Group paths are resolved based on the `sourceTree` property
    // which can have one of the following values:
    // - '<group>': The group path is relative to the parent group of the group
    // - 'SOURCE_ROOT': The group path is relative to the source root, i.e. the directory where the Xcode project is located
    // - 'BUILT_PRODUCTS_DIR': The group path is relative to the built products directory, i.e. the build output directory in derived data
    // - 'SDKROOT': The group path is relative to the SDK root, i.e. the directory where the SDK is installed
    // - 'DEVELOPER_DIR': The group path is relative to the developer directory, i.e. the directory where the Xcode command line tools are installed

    // The default is '<group>'
    const groupSourceTree =
      group.obj.sourceTree?.replace(/"/g, "") ?? "<group>";

    switch (groupSourceTree) {
      case "<group>":
        return this.resolvePathOfGroupRelativeToGroup(group);
      case "SOURCE_ROOT":
        return this.resolvePathOfGroupRelativeToSourceRoot(group);
      case "BUILT_PRODUCTS_DIR":
        return this.resolvePathOfGroupRelativeToBuiltProductsDir(group);
      case "SDKROOT":
        return this.resolvePathOfGroupRelativeToSdkRoot(group);
      case "DEVELOPER_DIR":
        return this.resolvePathOfGroupRelativeToDeveloperDir(group);
      default:
        debug(
          `Unknown source tree '${groupSourceTree}' for group: ${group.id}`,
        );
        return undefined;
    }
  }

  /**
   * Resolves the path of a group relative to the parent group.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the parent group, or undefined if the group is not found or has no path
   */
  private resolvePathOfGroupRelativeToGroup(
    group: XcodeProjectObjectWithId<PBXGroup>,
  ): string | undefined {
    const parentGroup = this.findParentGroupByChildId(group.id);

    if (!parentGroup) {
      debug(`Parent group not found for group: ${group.id}`);
      // If the parent group is not found, check if the group is the main group
      // We assume the main group is at the root of the project
      if (this.isMainGroup(group.id)) {
        return this.baseDir;
      }
      return undefined;
    }

    const parentGroupPath = this.resolveAbsolutePathOfGroup(parentGroup);
    if (!parentGroupPath) {
      debug(`Failed to resolve path of parent group: ${parentGroup.id}`);
      return undefined;
    }

    const groupPath = group.obj.path?.replace(/"/g, "") ?? "";
    if (!groupPath) {
      debug(`Group path not found for group: ${group.id}`);
      return undefined;
    }

    return path.join(parentGroupPath, groupPath);
  }

  /**
   * Resolves the path of a group relative to the source root.
   *
   * The source root is the directory where the `.xcodeproj` file is located.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the source root, or undefined if the group is not found or has no path
   */
  private resolvePathOfGroupRelativeToSourceRoot(
    group: XcodeProjectObjectWithId<PBXGroup>,
  ): string | undefined {
    const groupPath = group.obj.path?.replace(/"/g, "") ?? "";
    if (!groupPath) {
      debug(`Group path not found for group: ${group.id}`);
      return this.baseDir;
    }
    return path.join(this.baseDir, groupPath);
  }

  /**
   * Resolves the path of a group relative to the built products directory.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the built products directory, or undefined if the group is not found or has no path
   */
  private resolvePathOfGroupRelativeToBuiltProductsDir(
    group: XcodeProjectObjectWithId<PBXGroup>,
  ): string | undefined {
    debug(
      `Resolving path of group: ${group.id} relative to built products directory`,
    );
    const builtProductsDir = this.getBuildProductsDirectoryPath();
    if (!builtProductsDir) {
      debug(`Failed to resolve built products directory path`);
      return undefined;
    }

    return path.join(builtProductsDir, group.obj.path?.replace(/"/g, "") ?? "");
  }

  /**
   * Resolves the path of a group relative to the SDK root.
   *
   * The SDK root is the directory where the SDK is installed.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the SDK root, or undefined if the group is not found or has no path
   */
  private resolvePathOfGroupRelativeToSdkRoot(
    group: XcodeProjectObjectWithId<PBXGroup>,
  ): string | undefined {
    debug(`Resolving path of group: ${group.id} relative to SDK root`);
    const sdkRoot = MacOSSystemHelpers.findSDKRootDirectoryPath();
    if (!sdkRoot) {
      debug(`Failed to resolve SDK root directory path`);
      return undefined;
    }

    return path.join(sdkRoot, group.obj.path?.replace(/"/g, "") ?? "");
  }

  /**
   * Resolves the path of a group relative to the developer directory.
   *
   * The developer directory is the directory where the Xcode command line tools are installed.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the developer directory, or undefined if the group is not found or has no path
   */
  private resolvePathOfGroupRelativeToDeveloperDir(
    group: XcodeProjectObjectWithId<PBXGroup>,
  ): string | undefined {
    debug(
      `Resolving path of group: ${group.id} relative to developer directory`,
    );
    const developerDir = MacOSSystemHelpers.findDeveloperDirectoryPath();
    if (!developerDir) {
      debug(`Failed to resolve developer directory path`);
      return undefined;
    }

    return path.join(developerDir, group.obj.path?.replace(/"/g, "") ?? "");
  }

  /**
   * Resolves the absolute path of a group.
   *
   * @param group - The group to resolve the path of
   * @returns The absolute path of the group, or undefined if the group is not found or has no path
   */
  private resolveAbsolutePathOfSynchronizedRootGroup(
    group: XcodeProjectObjectWithId<PBXFileSystemSynchronizedRootGroup>,
  ): string | undefined {
    debug(
      `Resolving path of synchronized root group: ${group.id} with path: ${
        group.obj.path ?? ""
      }`,
    );

    // Group paths are resolved based on the `sourceTree` property
    // which can have one of the following values:
    // - '<group>': The group path is relative to the parent group of the group
    // - 'SOURCE_ROOT': The group path is relative to the source root, i.e. the directory where the Xcode project is located
    // - 'BUILT_PRODUCTS_DIR': The group path is relative to the built products directory, i.e. the build output directory in derived data
    // - 'SDKROOT': The group path is relative to the SDK root, i.e. the directory where the SDK is installed
    // - 'DEVELOPER_DIR': The group path is relative to the developer directory, i.e. the directory where the Xcode command line tools are installed

    // The default is '<group>'
    const groupSourceTree =
      group.obj.sourceTree?.replace(/"/g, "") ?? "<group>";

    switch (groupSourceTree) {
      case "<group>":
        return this.resolvePathOfSynchronizedRootGroupRelativeToGroup(group);
      case "SOURCE_ROOT":
        return this.resolvePathOfSynchronizedRootGroupRelativeToSourceRoot(
          group,
        );
      case "BUILT_PRODUCTS_DIR":
        return this.resolvePathOfSynchronizedRootGroupRelativeToBuiltProductsDir(
          group,
        );
      case "SDKROOT":
        return this.resolvePathOfSynchronizedRootGroupRelativeToSdkRoot(group);
      case "DEVELOPER_DIR":
        return this.resolvePathOfSynchronizedRootGroupRelativeToDeveloperDir(
          group,
        );
      default:
        debug(
          `Unknown source tree '${groupSourceTree}' for group: ${group.id}`,
        );
        return undefined;
    }
  }

  /**
   * Resolves the path of a group relative to the parent group.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the parent group, or undefined if the group is not found or has no path
   */
  private resolvePathOfSynchronizedRootGroupRelativeToGroup(
    group: XcodeProjectObjectWithId<PBXFileSystemSynchronizedRootGroup>,
  ): string | undefined {
    const parentGroup = this.findParentGroupByChildId(group.id);

    if (!parentGroup) {
      debug(`Parent group not found for group: ${group.id}`);
      // If the parent group is not found, check if the group is the main group
      // We assume the main group is at the root of the project
      if (this.isMainGroup(group.id)) {
        return this.baseDir;
      }
      return undefined;
    }

    const parentGroupPath = this.resolveAbsolutePathOfGroup(parentGroup);
    if (!parentGroupPath) {
      debug(`Failed to resolve path of parent group: ${parentGroup.id}`);
      return undefined;
    }

    const groupPath = group.obj.path?.replace(/"/g, "") ?? "";
    if (!groupPath) {
      debug(`Group path not found for group: ${group.id}`);
      return undefined;
    }

    return path.join(parentGroupPath, groupPath);
  }

  /**
   * Resolves the path of a group relative to the source root.
   *
   * The source root is the directory where the `.xcodeproj` file is located.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the source root, or undefined if the group is not found or has no path
   */
  private resolvePathOfSynchronizedRootGroupRelativeToSourceRoot(
    group: XcodeProjectObjectWithId<PBXFileSystemSynchronizedRootGroup>,
  ): string | undefined {
    const groupPath = group.obj.path?.replace(/"/g, "") ?? "";
    if (!groupPath) {
      debug(`Group path not found for group: ${group.id}`);
      return this.baseDir;
    }
    return path.join(this.baseDir, groupPath);
  }

  /**
   * Resolves the path of a group relative to the built products directory.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the built products directory, or undefined if the group is not found or has no path
   */
  private resolvePathOfSynchronizedRootGroupRelativeToBuiltProductsDir(
    group: XcodeProjectObjectWithId<PBXFileSystemSynchronizedRootGroup>,
  ): string | undefined {
    debug(
      `Resolving path of synchronized root group: ${group.id} relative to built products directory`,
    );
    const builtProductsDir = this.getBuildProductsDirectoryPath();
    if (!builtProductsDir) {
      debug(`Failed to resolve built products directory path`);
      return undefined;
    }

    return path.join(builtProductsDir, group.obj.path?.replace(/"/g, "") ?? "");
  }

  /**
   * Resolves the path of a group relative to the SDK root.
   *
   * The SDK root is the directory where the SDK is installed.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the SDK root, or undefined if the group is not found or has no path
   */
  private resolvePathOfSynchronizedRootGroupRelativeToSdkRoot(
    group: XcodeProjectObjectWithId<PBXFileSystemSynchronizedRootGroup>,
  ): string | undefined {
    debug(`Resolving path of group: ${group.id} relative to SDK root`);
    const sdkRoot = MacOSSystemHelpers.findSDKRootDirectoryPath();
    if (!sdkRoot) {
      debug(`Failed to resolve SDK root directory path`);
      return undefined;
    }

    return path.join(sdkRoot, group.obj.path?.replace(/"/g, "") ?? "");
  }

  /**
   * Resolves the path of a group relative to the developer directory.
   *
   * The developer directory is the directory where the Xcode command line tools are installed.
   *
   * @param group - The group to resolve the path of
   * @returns The path of the group relative to the developer directory, or undefined if the group is not found or has no path
   */
  private resolvePathOfSynchronizedRootGroupRelativeToDeveloperDir(
    group: XcodeProjectObjectWithId<PBXFileSystemSynchronizedRootGroup>,
  ): string | undefined {
    debug(
      `Resolving path of synchronized root group: ${group.id} relative to developer directory`,
    );
    const developerDir = MacOSSystemHelpers.findDeveloperDirectoryPath();
    if (!developerDir) {
      debug(`Failed to resolve developer directory path`);
      return undefined;
    }

    return path.join(developerDir, group.obj.path?.replace(/"/g, "") ?? "");
  }

  /**
   * Finds all files in the synchronized root groups of a target.
   *
   * @param nativeTarget - The target to find the files in
   * @returns The files in the synchronized root groups of the target, or an empty array if the target is not found or has no synchronized root groups
   */
  findFilesInSynchronizedRootGroups(
    nativeTarget: XcodeProjectObjectWithId<PBXNativeTarget>,
  ): string[] {
    debug(
      `Finding files in synchronized root groups for target: ${nativeTarget.obj.name}`,
    );
    const synchronizedRootGroups =
      nativeTarget.obj.fileSystemSynchronizedGroups ?? [];

    const result: string[] = [];
    for (const group of synchronizedRootGroups) {
      const groupObj =
        this.objects.PBXFileSystemSynchronizedRootGroup?.[group.value];
      if (!groupObj || typeof groupObj !== "object") {
        debug(`Synchronized root group not found: ${group.value}`);
        continue;
      }
      debug(`Found synchronized root group: ${group.value}`);

      const files = this.getFilesInSynchronizedRootGroup({
        id: group.value,
        obj: groupObj,
      });
      debug(
        `Found ${files.length} files in synchronized root group: ${group.value}`,
      );
      result.push(...files.map((file) => file.path));
    }
    debug(
      `Found ${result.length} files in synchronized root groups for target: ${nativeTarget.obj.name}`,
    );
    return result;
  }

  private getFilesInSynchronizedRootGroup(
    group: XcodeProjectObjectWithId<PBXFileSystemSynchronizedRootGroup>,
  ): ProjectFile[] {
    // Group path is expected to be set, therefore typing is non-nullable.
    // As the group is loaded from a project file, it is not guaranteed to be set,
    // therefore we treat it as optional.
    if (!group.obj.path) {
      debug(`Group path not found for group: ${group.id}`);
      return [];
    }

    // Resolve the path of the synchronized root group
    const absoluteGroupPath =
      this.resolveAbsolutePathOfSynchronizedRootGroup(group);
    if (!absoluteGroupPath) {
      debug(`Failed to resolve path of synchronized root group: ${group.id}`);
      return [];
    }

    // Build a list of all exception paths for the group
    const exceptionSets = this.getExceptionSetsForGroup(group);

    // Resolve a list of all files in the group
    const files = this.getAbsoluteFilePathsInDirectoryTree(absoluteGroupPath);

    // Filter out files that are excluded by the exception sets
    const filteredFiles = this.filterFilesByExceptionSets(files, exceptionSets);

    return filteredFiles;
  }

  /**
   * Returns all files in a directory tree.
   *
   * @param dirPath - The path of the directory to get the files in
   * @returns All files in the directory tree, or an empty array if the directory does not exist
   */
  private getAbsoluteFilePathsInDirectoryTree(dirPath: string): ProjectFile[] {
    // If the directory does not exist, return an empty array
    // This can happen if the group is not found in the project
    if (!existsSync(dirPath)) {
      return [];
    }
    const result: ProjectFile[] = [];
    const files = readdirSync(dirPath);
    for (const file of files) {
      // Ignore hidden files and directories
      if (file.startsWith(".")) {
        continue;
      }

      const filePath = path.join(dirPath, file);
      // If the file is a directory, recursively get the files in the directory
      if (statSync(filePath).isDirectory()) {
        result.push(...this.getAbsoluteFilePathsInDirectoryTree(filePath));
        continue;
      }
      // If the file is a file, add it to the result
      if (statSync(filePath).isFile()) {
        result.push({
          name: file,
          path: filePath,
        });
        continue;
      }
    }

    return result;
  }

  private filterFilesByExceptionSets(
    files: ProjectFile[],
    exceptionSets: XcodeProjectObjectWithId<PBXFileSystemSynchronizedBuildFileExceptionSet>[],
  ): ProjectFile[] {
    // Iterate over all files and filter out files that are excluded by any exception sets
    return files.filter((file) => {
      return !exceptionSets.some((exceptionSet) => {
        const membershipExceptions =
          exceptionSet.obj.membershipExceptions ?? [];
        return membershipExceptions.some((path) => {
          const unescapedPath = path.replace(/"/g, "");
          return file.path.includes(unescapedPath);
        });
      });
    });
  }

  // ================================ GROUP HELPERS ================================

  /**
   * Returns all groups that are PBXGroup.
   *
   * This is a helper method to avoid having to map and filter the groups manually.
   *
   * @returns All groups that are PBXGroup, excluding comments and non-object values.
   */
  private get groups(): XcodeProjectObjectWithId<PBXGroup>[] {
    // Map and filter the groups to only include the groups that are PBXGroup
    return Object.entries(this.objects.PBXGroup ?? {}).reduce(
      (acc, [key, group]) => {
        if (typeof group !== "object") {
          return acc;
        }
        return [
          ...acc,
          {
            id: key,
            obj: group,
          },
        ];
      },
      new Array<XcodeProjectObjectWithId<PBXGroup>>(),
    );
  }

  /**
   * Finds the parent group of a child group or file reference.
   *
   * @param childId - The ID of the child group or file reference
   * @returns The parent group of the child group or file reference, or undefined if the child group or file reference is not found or has no parent group
   */
  private findParentGroupByChildId(
    childId: string,
  ): XcodeProjectObjectWithId<PBXGroup> | undefined {
    return this.groups.find((group) => {
      return (group.obj.children ?? []).some((child) => {
        return child.value === childId;
      });
    });
  }

  /**
   * Checks if a group is the main group of any project.
   *
   * @param groupId - The ID of the group to check
   * @returns True if the group is the main group, false otherwise
   */
  private isMainGroup(groupId: string): boolean {
    return Object.values(this.objects.PBXProject ?? {}).some((project) => {
      if (typeof project !== "object") {
        return false;
      }
      return project.mainGroup === groupId;
    });
  }

  private getExceptionSetsForGroup(
    group: XcodeProjectObjectWithId<PBXFileSystemSynchronizedRootGroup>,
  ): XcodeProjectObjectWithId<PBXFileSystemSynchronizedBuildFileExceptionSet>[] {
    const exceptions = group.obj.exceptions ?? [];
    const exceptionSets: XcodeProjectObjectWithId<PBXFileSystemSynchronizedBuildFileExceptionSet>[] =
      [];
    for (const exception of exceptions) {
      const exceptionSet =
        this.objects.PBXFileSystemSynchronizedBuildFileExceptionSet?.[
          exception.value
        ];
      if (typeof exceptionSet !== "object") {
        continue;
      }
      exceptionSets.push({
        id: exception.value,
        obj: exceptionSet,
        comment: exception.comment,
      });
    }
    return exceptionSets;
  }

  /**
   * The path to the build products directory for the project.
   *
   * This is cached to avoid having to read the build settings from Xcode for each call to `getBuildProductsDirectoryPath`.
   */
  private buildProductsDir: string | undefined;

  /**
   * Returns the path to the build products directory for the project.
   *
   * @returns The path to the build products directory for the project, or undefined if the path is not found
   */
  private getBuildProductsDirectoryPath(): string | undefined {
    if (this.buildProductsDir) {
      return this.buildProductsDir;
    }
    const buildSettings = MacOSSystemHelpers.readXcodeBuildSettings(
      this.xcodeprojPath,
    );
    if (!buildSettings) {
      debug(`Failed to read Xcode build settings`);
      return undefined;
    }
    this.buildProductsDir =
      buildSettings["TARGET_BUILD_DIR"] ?? buildSettings["BUILD_DIR"];

    return this.buildProductsDir;
  }
}
