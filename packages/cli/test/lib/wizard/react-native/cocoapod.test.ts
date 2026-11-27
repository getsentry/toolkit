import { setTag } from "@sentry/node";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import {
  addCocoaPods,
  addModularHeaders,
  podInstall,
  usesCocoaPod,
} from "../../../../src/lib/wizard/react-native/cocoapod.js";
import { reportCliError } from "../../../../src/lib/error-reporting.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as bash from "../../../../src/lib/wizard/utils/bash.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as clack from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@clack/prompts", async () => ({
  ...(await vi.importActual<typeof clack>("@clack/prompts")),
}));

vi.mock("../../../../src/lib/wizard/utils/bash.js");
vi.mock("../../../../src/lib/error-reporting.js", () => ({
  reportCliError: vi.fn(),
}));
vi.mock("@sentry/node", async () => {
  const actual =
    await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
  return {
    ...actual,
    setTag: vi.fn(),
  };
});

const clackSpinnerMock = {
  start: vi.fn(),
  stop: vi.fn(),
  message: vi.fn(),
};

describe("cocoapod", () => {
  beforeEach(() => {
    vi.spyOn(clack, "spinner").mockReturnValue(clackSpinnerMock);
    vi.spyOn(clack.log, "error").mockImplementation(() => {
      /* empty */
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("usesCocoaPod", () => {
    describe("Podfile exists", () => {
      it("should return true", () => {
        // -- Arrange --
        const projPath = path.join(os.tmpdir(), "test-project-with-podfile");
        const tempDir = fs.mkdtempSync(projPath);

        const podfile = path.join(tempDir, "Podfile");
        fs.writeFileSync(podfile, "");

        // -- Act --
        const result = usesCocoaPod(tempDir);

        // -- Assert --
        expect(result).toBeTruthy();
      });
    });

    describe("Podfile does not exist", () => {
      it("should return false", () => {
        // -- Arrange --
        const projPath = path.join(os.tmpdir(), "test-project-without-podfile");
        const tempDir = fs.mkdtempSync(projPath);

        // -- Act --
        const result = usesCocoaPod(tempDir);

        // -- Assert --
        expect(result).toBeFalsy();
      });
    });
  });

  describe("addCocoaPods", () => {
    describe("Podfile does not exist", () => {
      it("should throw an error", async () => {
        // -- Arrange --
        const projPath = path.join(os.tmpdir(), "test-project-without-podfile");
        const tempDir = fs.mkdtempSync(projPath);

        // -- Act & Assert --
        await expect(addCocoaPods(tempDir)).rejects.toThrow(
          "ENOENT: no such file or directory, open",
        );
      });
    });

    describe("Podfile exists", () => {
      describe("Podfile includes Sentry pod", () => {
        const variations = [
          {
            case: "simple",
            content: 'pod "Sentry"',
          },
          {
            case: "with-swiftui",
            content: 'pod "SentrySwiftUI"',
          },
          {
            case: "leading-space",
            content: '  pod "Sentry"',
          },
          {
            case: "leading-space-and-swiftui",
            content: '  pod "SentrySwiftUI"',
          },
          {
            case: "trailing-space",
            content: 'pod "Sentry" ',
          },
          {
            case: "trailing-space-and-swiftui",
            content: 'pod "SentrySwiftUI" ',
          },
          {
            case: "single-quotes",
            content: "pod 'Sentry'",
          },
          {
            case: "double-quotes",
            content: 'pod "Sentry"',
          },
        ];
        for (const variation of variations) {
          it(`should not change the Podfile for ${variation.case}`, async () => {
            // -- Arrange --
            const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "project"));
            fs.mkdirSync(projPath, {
              recursive: true,
            });

            const podfile = path.join(projPath, "Podfile");
            fs.writeFileSync(podfile, variation.content, "utf8");

            // -- Act --
            const result = await addCocoaPods(projPath);

            // -- Assert --
            expect(result).toBeTruthy();
            expect(fs.readFileSync(podfile, "utf8")).toBe(variation.content);
          });
        }
      });

      describe("Podfile includes no other pods", () => {
        describe("Podfile does not include use_frameworks!", () => {
          it("should not change the Podfile", async () => {
            // -- Arrange --
            const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "project"));
            fs.mkdirSync(projPath, {
              recursive: true,
            });

            const podfile = path.join(projPath, "Podfile");
            fs.writeFileSync(podfile, "", "utf8");

            // -- Act --
            const result = await addCocoaPods(projPath);

            // -- Assert --
            expect(result).toBeFalsy();
            expect(fs.readFileSync(podfile, "utf8")).toBe("");
          });
        });

        describe("Podfile includes use_frameworks!", () => {
          it("should change the Podfile", async () => {
            // -- Arrange --
            const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "project"));
            fs.mkdirSync(projPath, {
              recursive: true,
            });

            const podfile = path.join(projPath, "Podfile");
            fs.writeFileSync(podfile, `use_frameworks!`, "utf8");

            // -- Act --
            const result = await addCocoaPods(projPath);

            // -- Assert --
            expect(result).toBeTruthy();
            expect(fs.readFileSync(podfile, "utf8")).toBe(
              `use_frameworks!\npod 'Sentry'\n`,
            );
          });
        });
      });

      describe("Podfile includes other pods", () => {
        it("should append Sentry pod after last pod", async () => {
          // -- Arrange --
          const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "project"));
          fs.mkdirSync(projPath, {
            recursive: true,
          });

          const podfile = path.join(projPath, "Podfile");
          fs.writeFileSync(podfile, 'pod "OtherPod"', "utf8");

          // -- Act --
          const result = await addCocoaPods(projPath);

          // -- Assert --
          expect(result).toBeTruthy();
          expect(fs.readFileSync(podfile, "utf8")).toBe(
            `pod "OtherPod"\npod 'Sentry'\n`,
          );
        });
      });
    });
  });

  describe("addModularHeaders", () => {
    describe("Podfile does not exist", () => {
      it("should return false and not create a Podfile", () => {
        // -- Arrange --
        const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "project"));

        // -- Act --
        const result = addModularHeaders(projPath);

        // -- Assert --
        expect(result).toBe(false);
        expect(fs.existsSync(path.join(projPath, "Podfile"))).toBe(false);
      });
    });

    describe("Podfile already includes use_modular_headers!", () => {
      const variations = [
        { case: "simple", content: "use_modular_headers!\n" },
        { case: "leading-space", content: "  use_modular_headers!\n" },
        {
          case: "within-target",
          content: `target 'App' do\n  use_modular_headers!\nend\n`,
        },
      ];
      for (const variation of variations) {
        it(`should not change the Podfile for ${variation.case}`, () => {
          // -- Arrange --
          const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "project"));
          const podfile = path.join(projPath, "Podfile");
          fs.writeFileSync(podfile, variation.content, "utf8");

          // -- Act --
          const result = addModularHeaders(projPath);

          // -- Assert --
          expect(result).toBe(true);
          expect(fs.readFileSync(podfile, "utf8")).toBe(variation.content);
        });
      }
    });

    describe("Podfile includes a target block", () => {
      it("should insert use_modular_headers! above the target block", () => {
        // -- Arrange --
        const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "project"));
        const podfile = path.join(projPath, "Podfile");
        fs.writeFileSync(
          podfile,
          `platform :ios, min_ios_version_supported\n\ntarget 'App' do\n  use_react_native!\nend\n`,
          "utf8",
        );

        // -- Act --
        const result = addModularHeaders(projPath);

        // -- Assert --
        expect(result).toBe(true);
        expect(fs.readFileSync(podfile, "utf8")).toBe(
          `platform :ios, min_ios_version_supported\n\nuse_modular_headers!\n\ntarget 'App' do\n  use_react_native!\nend\n`,
        );
      });

      it("should ignore commented-out target blocks", () => {
        // -- Arrange --
        const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "project"));
        const podfile = path.join(projPath, "Podfile");
        fs.writeFileSync(
          podfile,
          `# target 'Commented' do\ntarget 'App' do\nend\n`,
          "utf8",
        );

        // -- Act --
        const result = addModularHeaders(projPath);

        // -- Assert --
        expect(result).toBe(true);
        expect(fs.readFileSync(podfile, "utf8")).toBe(
          `# target 'Commented' do\nuse_modular_headers!\n\ntarget 'App' do\nend\n`,
        );
      });
    });

    describe("Podfile has no target block", () => {
      it("should append use_modular_headers! to the end", () => {
        // -- Arrange --
        const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "project"));
        const podfile = path.join(projPath, "Podfile");
        fs.writeFileSync(podfile, `platform :ios, '15.1'`, "utf8");

        // -- Act --
        const result = addModularHeaders(projPath);

        // -- Assert --
        expect(result).toBe(true);
        expect(fs.readFileSync(podfile, "utf8")).toBe(
          `platform :ios, '15.1'\nuse_modular_headers!\n`,
        );
      });
    });
  });

  describe("podInstall", () => {
    let workDir: string;

    beforeEach(() => {
      workDir = path.join(os.tmpdir(), "test-project");
    });

    describe("any bash scripts fail", () => {
      beforeEach(() => {
        vi.spyOn(bash, "execute").mockRejectedValue(new Error("test error"));
      });

      it("should not throw an error", async () => {
        // -- Act & Assert --
        await expect(podInstall(workDir)).resolves.not.toThrow();
      });

      it("should set tag", async () => {
        // -- Act --
        await podInstall(workDir);

        // -- Assert --
        expect(setTag).toHaveBeenCalledWith("pods-installed", false);
      });

      it("should capture exception", async () => {
        // -- Act --
        await podInstall(workDir);

        // -- Assert --
        expect(reportCliError).toHaveBeenCalledWith(
          new Error("Sentry pod install failed."),
        );
      });

      it("should start and stop spinner", async () => {
        // -- Act --
        await podInstall(workDir);

        // -- Assert --
        expect(clackSpinnerMock.start).toHaveBeenCalledWith(
          "Running 'pod install'. This may take a few minutes...",
        );
        expect(clackSpinnerMock.stop).toHaveBeenCalledWith(
          "Failed to install pods.",
        );
      });
    });

    describe("all bash scripts work", () => {
      beforeEach(() => {
        vi.spyOn(bash, "execute").mockResolvedValue("");
      });

      it("should call pod update and install", async () => {
        // -- Act --
        await podInstall(workDir);

        // -- Assert --
        expect(bash.execute).toHaveBeenCalledWith(
          `cd ${workDir} && pod repo update`,
        );
        expect(bash.execute).toHaveBeenCalledWith(
          `cd ${workDir} && pod install --silent`,
        );
      });

      it("should set tag", async () => {
        // -- Act --
        await podInstall(workDir);

        // -- Assert --
        expect(setTag).toHaveBeenCalledWith("pods-installed", true);
      });

      it("should start and stop spinner", async () => {
        // -- Act --
        await podInstall(workDir);

        // -- Assert --
        expect(clackSpinnerMock.start).toHaveBeenCalledWith(
          "Running 'pod install'. This may take a few minutes...",
        );
        expect(clackSpinnerMock.stop).toHaveBeenCalledWith("Pods installed.");
      });
    });

    describe("dir not given", () => {
      it("should use current directory", async () => {
        // -- Act --
        await podInstall();

        // -- Assert --
        expect(bash.execute).toHaveBeenCalledWith(`cd . && pod repo update`);
        expect(bash.execute).toHaveBeenCalledWith(
          `cd . && pod install --silent`,
        );
      });
    });
  });
});
