/**
 * Types for the `xcode` package, which ships none. Written by hand from the
 * Xcode project files the package parses, so most fields are optional:
 * only the ones the Apple and React Native wizards rely on are required.
 */

declare module "xcode" {
  interface PBXFileOptions {
    lastKnownFileType?: string;
    group?: string;
    customFramework?: boolean;
    defaultEncoding?: string;
    explicitFileType?: string;
    sourceTree?: string; // "<group>", "SOURCE_ROOT", "BUILT_PRODUCTS_DIR", "SDKROOT", "DEVELOPER_DIR", …
    weak?: boolean;
    compilerFlags?: string;
    embed?: boolean;
    sign?: boolean;
  }

  class PBXFile {
    basename?: string;
    lastKnownFileType?: string;
    group?: string;
    customFramework?: boolean;
    dirname?: string;
    path?: string;
    fileEncoding?: string;
    explicitFileType?: string;
    defaultEncoding?: string;
    sourceTree?: string; // "<group>", "SOURCE_ROOT", "BUILT_PRODUCTS_DIR", "SDKROOT", "DEVELOPER_DIR", …
    includeInIndex?: number;
    settings?: {
      ATTRIBUTES?: string[];
      COMPILER_FLAGS?: string;
    };

    constructor(filepath: string, opt?: PBXFileOptions);
  }

  export interface PBXBuildFile {
    isa: "PBXBuildFile";
    fileRef?: string;
    fileRef_comment?: string;
    productRef?: string;
    productRef_comment?: string;
    settings?: {
      ATTRIBUTES?: string[];
      COMPILER_FLAGS?: string;
    };
  }

  interface PBXWriterOptions {
    omitEmptyValues?: boolean;
  }

  class PBXWriter {
    constructor(contents: string, options: PBXWriterOptions);

    write(output: string): void;
    writeFlush(output: string): void;
    writeSync(): string;
    writeHeadComment(): void;
    writeProject(): void;
    writeObject(
      object: Record<string, unknown[] | object | string | number>,
    ): void;
    writeObjectsSections(
      objects: Record<string, unknown[] | object | string | number>,
    ): void;
    writeArray(
      arr: Array<
        | {
            value?: string;
            comment?: string;
          }
        | Record<string, unknown[] | object | string | number>
      >,
      name: string,
    ): void;

    writeSectionComment(name: string, begin: boolean): void;
    writeSection(
      section: Record<string, unknown[] | object | string | number>,
    ): void;
    writeInlineObject(
      name: string,
      comment: string,
      object: Record<string, unknown[] | object | string | number>,
    ): void;
  }

  export interface PBXNativeTarget {
    isa: "PBXNativeTarget";
    name: string;
    productType: string;

    buildConfigurationList?: string;
    buildConfigurationList_comment?: string;
    buildPhases?: {
      value: string;
      comment?: string;
    }[];
    buildRules?: Record<string, unknown>[];
    dependencies?: Record<string, unknown>[];
    fileSystemSynchronizedGroups?: {
      value: string;
      comment?: string;
    }[];
    packageProductDependencies?: {
      value: string;
      comment: string;
    }[];
    productName?: string;
    productReference?: string;
    productReference_comment?: string;
    productType?: string; // e.g. '"com.apple.product-type.application"'
  }

  export interface XCConfigurationList {
    isa: "XCConfigurationList";
    buildConfigurations?: {
      value: string;
      comment?: string;
    }[];
    defaultConfigurationIsVisible?: number;
    defaultConfigurationName?: string;
  }

  export interface PBXGroup {
    isa: "PBXGroup";
    children?: {
      value: string;
      comment?: string;
    }[];
    path?: string;
    sourceTree?: string; // "<group>", "SOURCE_ROOT", "BUILT_PRODUCTS_DIR", "SDKROOT", "DEVELOPER_DIR", …
  }

  type PBXCopyFilesBuildPhase = Record<string, unknown>;

  export interface XCBuildConfiguration {
    isa: "XCBuildConfiguration";
    buildSettings?: Record<string, string>;
    name?: string;
  }

  export interface PBXFrameworksBuildPhase {
    isa: "PBXFrameworksBuildPhase";
    buildActionMask?: number;
    files?: {
      value: string;
      comment?: string;
    }[];
    runOnlyForDeploymentPostprocessing?: number;
  }

  interface XCRemoteSwiftPackageReference {
    isa: "XCRemoteSwiftPackageReference";
    repositoryURL: string;
    requirement: {
      kind: string;
      minimumVersion: string;
    };
  }

  interface XCSwiftPackageProductDependency {
    isa: "XCSwiftPackageProductDependency";
    package: string;
    productName: string;
    package_comment?: string;
  }

  export interface PBXShellScriptBuildPhase {
    isa: "PBXShellScriptBuildPhase";
    buildActionMask?: number;
    files?: {
      value: string;
      comment?: string;
    }[];
    runOnlyForDeploymentPostprocessing?: number;
    inputFileListPaths?: string[];
    outputFileListPaths?: string[];
    inputPaths?: string[];
    outputPaths?: string[];
    shellPath?: string;
    shellScript?: string;
  }

  export interface PBXSourcesBuildPhase {
    isa: "PBXSourcesBuildPhase";
    buildActionMask?: number;
    files?: {
      value: string;
      comment?: string;
    }[];
    runOnlyForDeploymentPostprocessing?: number;
  }

  export interface PBXFileSystemSynchronizedRootGroup {
    isa: "PBXFileSystemSynchronizedRootGroup";
    path?: string;
    sourceTree?: string; // "<group>", "SOURCE_ROOT", "BUILT_PRODUCTS_DIR", "SDKROOT", "DEVELOPER_DIR", …
    exceptions?: {
      value: string;
      comment?: string;
    }[];
  }

  export interface PBXFileReference {
    isa: "PBXFileReference";
    path?: string;
    lastKnownFileType?: string; // e.g. "sourcecode.swift"
    sourceTree?: string; // "<group>", "SOURCE_ROOT", "BUILT_PRODUCTS_DIR", "SDKROOT", "DEVELOPER_DIR", …
  }
  export interface PBXFileSystemSynchronizedBuildFileExceptionSet {
    isa: "PBXFileSystemSynchronizedBuildFileExceptionSet";
    membershipExceptions?: string[];
    target: string;
    target_comment?: string;
  }

  export interface PBXObjects {
    PBXBuildFile?: Record<string, PBXBuildFile | string>;
    PBXCopyFilesBuildPhase?: Record<string, PBXCopyFilesBuildPhase | string>;
    PBXFileReference?: Record<string, PBXFileReference | string>;
    PBXFileSystemSynchronizedRootGroup?: Record<
      string,
      PBXFileSystemSynchronizedRootGroup | string
    >;
    PBXFileSystemSynchronizedBuildFileExceptionSet?: Record<
      string,
      PBXFileSystemSynchronizedBuildFileExceptionSet | string
    >;
    PBXFrameworksBuildPhase?: Record<string, PBXFrameworksBuildPhase | string>;
    PBXGroup?: Record<string, PBXGroup | string>;
    PBXNativeTarget?: Record<string, PBXNativeTarget | string>;
    PBXProject?: Record<string, PBXProject | string>;
    PBXShellScriptBuildPhase?: Record<
      string,
      PBXShellScriptBuildPhase | string
    >;
    PBXSourcesBuildPhase?: Record<string, PBXSourcesBuildPhase | string>;

    XCBuildConfiguration?: Record<string, XCBuildConfiguration | string>;
    /**
     * The XCConfigurationList is not always present in the project file.
     *
     * If the configuration list is not present, Xcode will declare the project as damaged.
     */
    XCConfigurationList?: Record<string, XCConfigurationList | string>;
    XCRemoteSwiftPackageReference?: Record<
      string,
      XCRemoteSwiftPackageReference | string
    >;
    XCSwiftPackageProductDependency?: Record<
      string,
      XCSwiftPackageProductDependency | string
    >;

    mainGroup: string;
    packageReferences?: {
      value: string;
      comment?: string;
    }[];
  }

  export interface PBXProject {
    isa: "PBXProject";
    attributes?: {
      BuildIndependentTargetsInParallel?: number;
      LastSwiftUpdateCheck?: number;
      LastUpgradeCheck?: number;
      TargetAttributes?: Record<
        string,
        {
          CreatedOnToolsVersion?: string;
        }
      >;
    };
    buildConfigurationList?: string;
    buildConfigurationList_comment?: string;
    developmentRegion?: string;
    hasScannedForEncodings?: number;
    knownRegions?: string[];
    mainGroup?: string;
    minimizedProjectReferenceProxies?: number;
    preferredProjectObjectVersion?: number;
    productRefGroup?: string;
    productRefGroup_comment?: string;
    projectDirPath?: string;
    projectRoot?: string;
    targets?: {
      value: string;
      comment?: string;
    }[];
  }

  export interface PBXResourcesBuildPhase {
    isa: "PBXResourcesBuildPhase";
    buildActionMask?: number;
    files?: {
      value: string;
      comment?: string;
    }[];
    runOnlyForDeploymentPostprocessing?: number;
  }

  export class Project extends import("events").EventEmitter {
    hash: {
      project: {
        objects: PBXObjects;
      };
    };

    filepath: string;

    constructor(filename: string);

    parse(cb: (err: Error | null) => void): void;
    parseSync(): void;

    writeSync(options?: PBXWriterOptions): string;
    allUuids(): string[];
    generateUuid(): string;

    addPluginFile(path: string, opt?: PBXFileOptions): void;
    removePluginFile(path: string, opt?: PBXFileOptions): void;

    addProductFile(targetPath: string, opt?: PBXFileOptions): void;
    removeProductFile(path: string, opt?: PBXFileOptions): void;

    addSourceFile(path: string, opt?: PBXFileOptions, group?: string): void;
    removeSourceFile(path: string, opt?: PBXFileOptions, group?: string): void;

    addHeaderFile(path: string, opt?: PBXFileOptions, group?: string): void;
    removeHeaderFile(path: string, opt?: PBXFileOptions, group?: string): void;

    addResourceFile(path: string, opt?: PBXFileOptions, group?: string): void;
    removeResourceFile(
      path: string,
      opt?: PBXFileOptions,
      group?: string,
    ): void;

    addFramework(fpath: string, opt?: PBXFileOptions): void;
    removeFramework(fpath: string, opt?: PBXFileOptions): void;

    addCopyfile(fpath: string, opt?: PBXFileOptions): void;
    removeCopyfile(fpath: string, opt?: PBXFileOptions): void;

    pbxCopyfilesBuildPhaseObj(target: string): PBXObjects;
    addToPbxCopyfilesBuildPhase(file: PBXObjects): void;
    removeFromPbxCopyfilesBuildPhase(file: PBXObjects): void;

    addStaticLibrary(
      path: string,
      opt: {
        plugin?: boolean;
        target?: string;
      },
    ): void;

    addToPbxBuildFileSection(file: PBXFile): void;
    removeFromPbxBuildFileSection(file: PBXFile): void;

    addPbxGroup(
      filePathsArray: string[],
      name: string,
      path: string,
      sourceTree: string,
    ): void;
    removePbxGroup(name: string): void;

    addToPbxProjectSection(target: PBXNativeTarget): void;
    addToPbxNativeTargetSection(target: PBXNativeTarget): void;
    addToPbxFileReferenceSection(file: PBXFile): void;

    removeFromPbxFileReferenceSection(file: PBXFile): void;

    addToXcVersionGroupSection(file: PBXFile): void;

    addToPluginsPbxGroup(file: PBXFile): void;
    removeFromPluginsPbxGroup(file: PBXFile): void;

    addToResourcesPbxGroup(file: PBXFile): void;
    removeFromResourcesPbxGroup(file: PBXFile): void;

    addToFrameworksPbxGroup(file: PBXFile): void;
    removeFromFrameworksPbxGroup(file: PBXFile): void;

    addToProductsPbxGroup(file: PBXFile): void;
    removeFromProductsPbxGroup(file: PBXFile): void;

    addToPbxSourcesBuildPhase(file: PBXFile): void;
    removeFromPbxSourcesBuildPhase(file: PBXFile): void;

    addToPbxResourcesBuildPhase(file: PBXFile): void;
    removeFromPbxResourcesBuildPhase(file: PBXFile): void;

    addToPbxFrameworksBuildPhase(file: PBXFile): void;
    removeFromPbxFrameworksBuildPhase(file: PBXFile): void;

    addXCConfigurationList(
      configurationObjectsArray: string[],
      defaultConfigurationName: string,
      comment: string,
    ): void;

    addTargetDependency(target: string, dependencyTargets: string[]): void;

    // oxlint-disable-next-line max-params -- types the xcode package's own signature
    addBuildPhase(
      filePathsArray: string[],
      buildPhaseType: "PBXShellScriptBuildPhase",
      comment: string,
      target: string | null,
      optionsOrFolderType:
        | {
            inputPaths?: string[];
            outputPaths?: string[];
            inputFileListPaths?: string[];
            outputFileListPaths?: string[];
            shellPath: string;
            shellScript: string;
          }
        | string,
      subfolderPath?: string,
    ): void;

    pbxProjectSection(): PBXObjects;
    pbxBuildFileSection(): PBXObjects;
    pbxXCBuildConfigurationSection(): PBXObjects;
    pbxFileReferenceSection(): PBXObjects;
    pbxNativeTargetSection(): PBXObjects;
    xcVersionGroupSection(): PBXObjects;

    pbxXCConfigurationList(): PBXObjects;
    pbxGroupByName(name: string): PBXObjects;
    pbxTargetByName(name: string): PBXNativeTarget | undefined;
    findTargetKey(name: string): string;

    pbxItemByComment(name: string, pbxSectionName: string): PBXObjects;
    pbxSourcesBuildPhaseObj(target: string): PBXObjects;
    pbxResourcesBuildPhaseObj(target: string): PBXObjects;
    pbxFrameworksBuildPhaseObj(target: string): PBXObjects;
    pbxEmbedFrameworksBuildPhaseObj(target: string): PBXObjects;

    buildPhase(group: string, target: string): PBXObjects;
    buildPhaseObject(name: string, group: string, target: string): PBXObjects;

    addBuildProperty(prop: string, value: string, build_name: string): void;
    removeBuildProperty(prop: string, build_name: string): void;

    updateBuildProperty(
      prop: string,
      value: string,
      build: string,
      targetName: string,
    ): void;

    updateProductName(name: string): void;
    removeFromFrameworkSearchPaths(file: string): void;

    addToFrameworkSearchPaths(file: string): void;
    removeFromLibrarySearchPaths(file: string): void;

    addToLibrarySearchPaths(file: string): void;
    removeFromHeaderSearchPaths(file: string): void;

    addToHeaderSearchPaths(file: string): void;
    addToOtherLinkerFlags(flag: string): void;
    removeFromOtherLinkerFlags(flag: string): void;

    addToBuildSettings(buildSetting: string, value: string): void;
    removeFromBuildSettings(buildSetting: string): void;

    readonly productName: string;

    hasFile(filePath: string): boolean;

    addTarget(
      name: string,
      type: string,
      subfolder: string,
      bundleId: string,
    ): void;

    getFirstProject(): {
      uuid: string;
      firstProject: PBXObjects;
    };
    getFirstTarget(): {
      uuid: string;
      firstTarget: PBXObjects;
    } | null;
    getTarget(productType: string): {
      uuid: string;
      target: PBXObjects;
    } | null;

    addToPbxGroupType(file: string, groupKey: string, groupType: string): void;
    addToPbxVariantGroup(file: string, groupKey: string): void;
    addToPbxGroup(file: string, groupKey: string): void;

    pbxCreateGroupWithType(
      name: string,
      pathName: string,
      groupType: string,
    ): void;
    pbxCreateVariantGroup(name: string): void;
    pbxCreateGroup(name: string, pathName: string): void;

    removeFromPbxGroupAndType(
      file: string,
      groupKey: string,
      groupType: string,
    ): void;
    removeFromPbxGroup(file: string, groupKey: string): void;
    removeFromPbxVariantGroup(file: string, groupKey: string): void;

    getPBXGroupByKeyAndType(key: string, groupType: string): PBXObjects;
    getPBXGroupByKey(key: string): PBXObjects;
    getPBXVariantGroupByKey(key: string): PBXObjects;

    findPBXGroupKeyAndType(
      criteria: {
        path?: string;
      },
      groupType: string,
    ): string;

    findPBXGroupKey(criteria: { path?: string }): string;

    findPBXVariantGroupKey(criteria: { path?: string }): string;

    addLocalizationVariantGroup(name: string): void;

    addKnownRegion(name: string): void;
    removeKnownRegion(name: string): void;

    hasKnownRegion(name: string): boolean;

    getPBXObject(name: string): PBXObjects;

    addFile(path: string, group: string, opt?: PBXFileOptions): void;
    removeFile(path: string, group: string, opt?: PBXFileOptions): void;

    getBuildProperty(prop: string, build: string, targetName: string): string;
    getBuildConfigByName(name: string): PBXObjects;

    addDataModelDocument(
      filePath: string,
      group: string,
      opt?: PBXFileOptions,
    ): void;
    addTargetAttribute(prop: string, value: string, target: string): void;
    removeTargetAttribute(prop: string, target: string): void;
  }

  export const project: (filename: string) => Project;

  export default {
    project: project,
  };
}
