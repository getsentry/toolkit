// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockXcodeProject = {
  projectPath: string;
  xcodeprojPath: string;
  getAllTargets: () => string[];
};

const mocks = vi.hoisted(() => {
  const targetsByProjectPath = new Map<string, string[]>();

  return {
    abort: vi.fn(() => {
      throw new Error("abort");
    }),
    askForItemSelection: vi.fn(),
    clackError: vi.fn(),
    debug: vi.fn(),
    searchXcodeProjectAtPath: vi.fn(),
    setTag: vi.fn(),
    targetsByProjectPath,
    traceStep: vi.fn(
      async <T>(_name: string, callback: () => Promise<T> | T): Promise<T> =>
        await callback(),
    ),
    XcodeProject: vi.fn(function (this: MockXcodeProject, projectPath: string) {
      this.projectPath = projectPath;
      this.xcodeprojPath = path.dirname(projectPath);
      this.getAllTargets = () => targetsByProjectPath.get(projectPath) ?? [];
    }),
  };
});

vi.mock("@clack/prompts", () => ({
  log: {
    error: mocks.clackError,
  },
}));

vi.mock(
  "../../../../src/lib/wizard/apple/search-xcode-project-at-path.js",
  () => ({
    searchXcodeProjectAtPath: mocks.searchXcodeProjectAtPath,
  }),
);

vi.mock("../../../../src/lib/wizard/apple/xcode-manager.js", () => ({
  XcodeProject: mocks.XcodeProject,
}));

vi.mock("../../../../src/lib/wizard/telemetry.js", () => ({
  Sentry: { setTag: mocks.setTag },
  traceStep: mocks.traceStep,
}));

vi.mock("../../../../src/lib/wizard/utils/clack/index.js", () => ({
  abort: mocks.abort,
  askForItemSelection: mocks.askForItemSelection,
}));

vi.mock("../../../../src/lib/wizard/utils/debug.js", () => ({
  debug: mocks.debug,
}));

import {
  lookupXcodeProject,
  selectXcodeTarget,
} from "../../../../src/lib/wizard/apple/lookup-xcode-project.js";

function createProject(projectDir: string, projectName: string): string {
  const projectPath = path.join(projectDir, projectName);
  fs.mkdirSync(projectPath, { recursive: true });
  const pbxprojPath = path.join(projectPath, "project.pbxproj");
  fs.writeFileSync(pbxprojPath, "mock pbxproj");

  return pbxprojPath;
}

function createMockXcodeProject(
  pbxprojPath: string,
): Parameters<typeof selectXcodeTarget>[0] {
  const XcodeProjectConstructor = mocks.XcodeProject as unknown as {
    new (projectPath: string): MockXcodeProject;
  };

  return new XcodeProjectConstructor(pbxprojPath) as unknown as Parameters<
    typeof selectXcodeTarget
  >[0];
}

describe("lookup-xcode-project", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "lookup-xcode-project-"),
    );
    vi.clearAllMocks();
    mocks.targetsByProjectPath.clear();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { force: true, recursive: true });
  });

  describe("lookupXcodeProject", () => {
    it("returns an Xcode project without selecting a target", async () => {
      const pbxprojPath = createProject(projectDir, "App.xcodeproj");
      mocks.searchXcodeProjectAtPath.mockReturnValue(["App.xcodeproj"]);
      mocks.targetsByProjectPath.set(pbxprojPath, ["App"]);

      const result = await lookupXcodeProject({ projectDir });

      expect(mocks.searchXcodeProjectAtPath).toHaveBeenCalledWith(projectDir);
      expect(mocks.XcodeProject).toHaveBeenCalledWith(pbxprojPath);
      expect(result).toEqual(
        expect.objectContaining({ projectPath: pbxprojPath }),
      );
      expect(mocks.askForItemSelection).not.toHaveBeenCalledWith(
        ["App"],
        "Which target do you want to add Sentry to?",
      );
    });

    it("prompts when multiple Xcode projects are found", async () => {
      createProject(projectDir, "First.xcodeproj");
      const selectedPbxprojPath = createProject(projectDir, "Second.xcodeproj");
      mocks.searchXcodeProjectAtPath.mockReturnValue([
        "First.xcodeproj",
        "Second.xcodeproj",
      ]);
      mocks.askForItemSelection.mockResolvedValue({
        value: "Second.xcodeproj",
      });

      const result = await lookupXcodeProject({ projectDir });

      expect(mocks.askForItemSelection).toHaveBeenCalledWith(
        ["First.xcodeproj", "Second.xcodeproj"],
        "Which project do you want to add Sentry to?",
      );
      expect(result).toEqual(
        expect.objectContaining({ projectPath: selectedPbxprojPath }),
      );
    });

    it("fails instead of prompting when multiple Xcode projects are found in non-interactive mode", async () => {
      createProject(projectDir, "First.xcodeproj");
      createProject(projectDir, "Second.xcodeproj");
      mocks.searchXcodeProjectAtPath.mockReturnValue([
        "First.xcodeproj",
        "Second.xcodeproj",
      ]);

      await expect(
        lookupXcodeProject({ projectDir, nonInteractive: true }),
      ).rejects.toThrow("abort");

      expect(mocks.askForItemSelection).not.toHaveBeenCalled();
      expect(mocks.clackError).toHaveBeenCalledWith(
        expect.stringContaining("Multiple Xcode projects found"),
      );
    });
  });

  describe("selectXcodeTarget", () => {
    it("returns the only target without prompting", async () => {
      const pbxprojPath = createProject(projectDir, "App.xcodeproj");
      mocks.targetsByProjectPath.set(pbxprojPath, ["App"]);
      const xcProject = createMockXcodeProject(pbxprojPath);

      const result = await selectXcodeTarget(xcProject);

      expect(result).toBe("App");
      expect(mocks.askForItemSelection).not.toHaveBeenCalled();
    });

    it("prompts when multiple targets are available", async () => {
      const pbxprojPath = createProject(projectDir, "App.xcodeproj");
      mocks.targetsByProjectPath.set(pbxprojPath, ["App", "Widget"]);
      mocks.askForItemSelection.mockResolvedValue({ value: "Widget" });
      const xcProject = createMockXcodeProject(pbxprojPath);

      const result = await selectXcodeTarget(xcProject);

      expect(mocks.askForItemSelection).toHaveBeenCalledWith(
        ["App", "Widget"],
        "Which target do you want to add Sentry to?",
      );
      expect(result).toBe("Widget");
    });

    it("selects from custom target candidates", async () => {
      const pbxprojPath = createProject(projectDir, "App.xcodeproj");
      mocks.targetsByProjectPath.set(pbxprojPath, ["App"]);
      mocks.askForItemSelection.mockResolvedValue({ value: "AppUITests" });
      const xcProject = createMockXcodeProject(pbxprojPath);

      const result = await selectXcodeTarget(xcProject, {
        targetNames: ["AppTests", "AppUITests"],
        promptMessage: "Which test target should render SnapshotPreviews?",
      });

      expect(mocks.askForItemSelection).toHaveBeenCalledWith(
        ["AppTests", "AppUITests"],
        "Which test target should render SnapshotPreviews?",
      );
      expect(result).toBe("AppUITests");
    });
  });
});
