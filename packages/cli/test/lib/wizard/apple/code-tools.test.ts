import { setTag } from "@sentry/node";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import {
  addCodeSnippetToProject,
  exportForTesting,
} from "../../../../src/lib/wizard/apple/code-tools.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as clack from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", async () => {
  const actual =
    await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
  return {
    ...actual,
    setTag: vi.fn(),
    captureException: vi.fn(() => "id"),
  };
});

// Test Constants
const invalidAppDelegateSwift = `func application() {}`;
const validAppDelegateSwift = `
import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }
}`;
const validAppDelegateSwiftWithSentry = `
import UIKit
import Sentry


@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        SentrySDK.start { options in
            options.dsn = "https://example.com/sentry-dsn"

            // Adds IP for users.
            // For more information, visit: https://docs.sentry.io/platforms/apple/data-management/data-collected/
            options.sendDefaultPii = true

            // Set tracesSampleRate to 1.0 to capture 100% of transactions for performance monitoring.
            // We recommend adjusting this value in production.
            options.tracesSampleRate = 1.0

            // Configure profiling. Visit https://docs.sentry.io/platforms/apple/profiling/ to learn more.
            options.configureProfiling = {
                $0.sessionSampleRate = 1.0 // We recommend adjusting this value in production.
                $0.lifecycle = .trace
            }

            // Uncomment the following lines to add more data to your events
            // options.attachScreenshot = true // This adds a screenshot to the error events
            // options.attachViewHierarchy = true // This adds the view hierarchy to the error events
        }
        // Remove the next line after confirming that your Sentry integration is working.
        SentrySDK.capture(message: "This app uses Sentry! :)")

        // Override point for customization after application launch.
        return true
    }
}`;
const invalidAppDelegateObjC = `
- (BOOL)application:(UIApplication *) {
  return NO;
}`;
const validAppDelegateObjC = `
#import "AppDelegate.h"

@interface AppDelegate ()

@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    // Override point for customization after application launch.
    return YES;
}

@end`;
const validAppDelegateObjCWithSentry = `@import Sentry;

#import "AppDelegate.h"

@interface AppDelegate ()

@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    [SentrySDK startWithConfigureOptions:^(SentryOptions * options) {
        options.dsn = @"https://example.com/sentry-dsn";

        // Adds IP for users.
        // For more information, visit: https://docs.sentry.io/platforms/apple/data-management/data-collected/
        options.sendDefaultPii = YES;

        // Set tracesSampleRate to 1.0 to capture 100% of transactions for performance monitoring.
        // We recommend adjusting this value in production.
        options.tracesSampleRate = @1.0;

        // Configure profiling. Visit https://docs.sentry.io/platforms/apple/profiling/ to learn more.
        options.configureProfiling = ^(SentryProfileOptions *profiling) {
            profiling.sessionSampleRate = 1.0; // We recommend adjusting this value in production.
            profiling.lifecycle = SentryProfilingLifecycleTrace;
        };

        //Uncomment the following lines to add more data to your events
        //options.attachScreenshot = YES; //This will add a screenshot to the error events
        //options.attachViewHierarchy = YES; //This will add the view hierarchy to the error events
    }];
    //Remove the next line after confirming that your Sentry integration is working.
    [SentrySDK captureMessage:@"This app uses Sentry!"];

    // Override point for customization after application launch.
    return YES;
}

@end`;
const invalidAppDelegateSwiftUI = `
struct MyApp: App {
  var body: some Scene {
    WindowGroup { Text("Hello, world!") }
  }
}`;
const validAppDelegateSwiftUI = `
import SwiftUI

@main
struct TestApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}`;
const validAppDelegateSwiftUIWithSentry = `
import SwiftUI
import Sentry


@main
struct TestApp: App {
    init() {
        SentrySDK.start { options in
            options.dsn = "https://example.com/sentry-dsn"

            // Adds IP for users.
            // For more information, visit: https://docs.sentry.io/platforms/apple/data-management/data-collected/
            options.sendDefaultPii = true

            // Set tracesSampleRate to 1.0 to capture 100% of transactions for performance monitoring.
            // We recommend adjusting this value in production.
            options.tracesSampleRate = 1.0

            // Configure profiling. Visit https://docs.sentry.io/platforms/apple/profiling/ to learn more.
            options.configureProfiling = {
                $0.sessionSampleRate = 1.0 // We recommend adjusting this value in production.
                $0.lifecycle = .trace
            }

            // Uncomment the following lines to add more data to your events
            // options.attachScreenshot = true // This adds a screenshot to the error events
            // options.attachViewHierarchy = true // This adds the view hierarchy to the error events
        }
        // Remove the next line after confirming that your Sentry integration is working.
        SentrySDK.capture(message: "This app uses Sentry! :)")
    }
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}`;
const validAppDelegateSwiftUIWithExistingInit = `
import SwiftUI

@main
struct TestApp: App {
    init() {
        // Some existing initialization
        print("App initialized")
    }
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}`;
// Expected output after wizard injects Sentry into existing init()
const validAppDelegateSwiftUIWithExistingInitAndSentry = `
import SwiftUI
import Sentry


@main
struct TestApp: App {
    init() {
        SentrySDK.start { options in
            options.dsn = "https://example.com/sentry-dsn"

            // Adds IP for users.
            // For more information, visit: https://docs.sentry.io/platforms/apple/data-management/data-collected/
            options.sendDefaultPii = true

            // Set tracesSampleRate to 1.0 to capture 100% of transactions for performance monitoring.
            // We recommend adjusting this value in production.
            options.tracesSampleRate = 1.0

            // Configure profiling. Visit https://docs.sentry.io/platforms/apple/profiling/ to learn more.
            options.configureProfiling = {
                $0.sessionSampleRate = 1.0 // We recommend adjusting this value in production.
                $0.lifecycle = .trace
            }

            // Uncomment the following lines to add more data to your events
            // options.attachScreenshot = true // This adds a screenshot to the error events
            // options.attachViewHierarchy = true // This adds the view hierarchy to the error events
        }
        // Remove the next line after confirming that your Sentry integration is working.
        SentrySDK.capture(message: "This app uses Sentry! :)")

        // Some existing initialization
        print("App initialized")
    }
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}`;

const prepareTempDir = (): string => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-tools-test"));
  return tempDir;
};

const prepareAppDelegateFile = (
  dir: string,
  content: string,
  ext: "m" | "mm" | "swift",
): string => {
  const filePath = path.join(dir, `AppDelegate.${ext}`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
};

const dsn = "https://example.com/sentry-dsn";

// Mock Setup

vi.mock("../../../../src/lib/wizard/utils/bash.js");

// Test Suite

describe("code-tools", () => {
  beforeEach(() => {
    vi.spyOn(clack.log, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("#isAppDelegateFile", () => {
    const prepareTestFile = (
      content: string,
      ext: "m" | "mm" | "swift",
    ): string => {
      const tempDir = prepareTempDir();
      return prepareAppDelegateFile(tempDir, content, ext);
    };

    describe("swift files", () => {
      describe("swift app launch regex", () => {
        describe("valid cases", () => {
          const variations: {
            name: string;
            code: string;
          }[] = [
            {
              name: "with underscores",
              code: "func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [NSObject: AnyObject]?) -> Bool {",
            },
            {
              name: "with different dictionary type",
              code: "func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {",
            },
            {
              name: "with extra whitespace",
              code: "  func  application  (  _  application:  UIApplication  ,   didFinishLaunchingWithOptions   launchOptions:   [  NSObject  :  AnyObject  ]?  )   ->   Bool   {  ",
            },
            {
              name: "macOS notification variant",
              code: "func applicationDidFinishLaunching(_ aNotification: Notification) {",
            },
            {
              name: "macOS with extra whitespace",
              code: "func   applicationDidFinishLaunching  (  _   aNotification:  Notification  )  {",
            },
          ];

          for (const variation of variations) {
            describe(variation.name, () => {
              it(`should return true`, () => {
                // -- Arrange --
                const filePath = prepareTestFile(variation.code, "swift");

                // -- Act --
                const result = exportForTesting.isAppDelegateFile(filePath);

                // -- Assert --
                expect(result).toBeTruthy();
              });
            });
          }

          describe("invalid cases", () => {
            const variations: {
              name: string;
              code: string;
            }[] = [
              {
                name: "missing application method",
                code: "import UIKit",
              },
              {
                name: "typo in method name",
                code: "func applicatioM(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [NSObject: AnyObject]?) -> Bool {",
              },
              {
                name: "garbage input",
                code: "asdf;jk23;uas()d{",
              },
            ];

            for (const variation of variations) {
              describe(variation.name, () => {
                it("should return false", () => {
                  // -- Arrange --
                  const filePath = prepareTestFile(variation.code, "swift");

                  // -- Act --
                  const result = exportForTesting.isAppDelegateFile(filePath);

                  // -- Assert --
                  expect(result).toBeFalsy();
                });
              });
            }
          });
        });
      });
    });

    describe("objc files", () => {
      describe("valid cases", () => {
        const variations: {
          name: string;
          code: string;
        }[] = [
          {
            name: "basic",
            code: "- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {",
          },
          {
            name: "with more whitespace",
            code: "-  (  BOOL )  application:  (  UIApplication  *   )   application   didFinishLaunchingWithOptions:  (  NSDictionary  *  )  launchOptions   {",
          },
        ];

        for (const variation of variations) {
          describe(variation.name, () => {
            it("should return true", () => {
              // -- Arrange --
              const filePath = prepareTestFile(variation.code, "m");

              // -- Act --
              const result = exportForTesting.isAppDelegateFile(filePath);

              // -- Assert --
              expect(result).toBeTruthy();
            });
          });
        }
      });

      describe("invalid cases", () => {
        const variations: {
          name: string;
          code: string;
        }[] = [
          {
            name: "missing application method",
            code: "import UIKit",
          },
        ];

        for (const variation of variations) {
          describe(variation.name, () => {
            it("should return false", () => {
              // -- Arrange --
              const filePath = prepareTestFile(variation.code, "m");

              // -- Act --
              const result = exportForTesting.isAppDelegateFile(filePath);

              // -- Assert --
              expect(result).toBeFalsy();
            });
          });
        }
      });
    });

    describe("swiftui files", () => {
      describe("valid cases", () => {
        const variations: {
          name: string;
          code: string;
        }[] = [
          {
            name: "basic",
            code: "@main struct MyApp: App {",
          },
          {
            name: "with more whitespace",
            code: "@main    struct   MyApp:   App   {",
          },
          {
            name: "with SwiftUI namespace",
            code: "@main struct App: SwiftUI.App {",
          },
        ];

        for (const variation of variations) {
          describe(variation.name, () => {
            it("should return true", () => {
              // -- Arrange --
              const filePath = prepareTestFile(variation.code, "swift");

              // -- Act --
              const result = exportForTesting.isAppDelegateFile(filePath);

              // -- Assert --
              expect(result).toBeTruthy();
            });
          });
        }
      });

      describe("invalid cases", () => {
        const variations: {
          name: string;
          code: string;
        }[] = [
          {
            name: "missing @main",
            code: "struct App: App {",
          },
          {
            name: "missing super-type App",
            code: "struct MyApp {",
          },
          {
            name: "imported not from SwiftUI",
            code: "@main struct App: MySwiftyUI.App {",
          },
          {
            name: "imported not from SwiftUI but similar",
            code: "@main struct App: MySwiftUI.App {",
          },
        ];

        for (const variation of variations) {
          describe(variation.name, () => {
            it("should return false", () => {
              // -- Arrange --
              const filePath = prepareTestFile(variation.code, "swift");

              // -- Act --
              const result = exportForTesting.isAppDelegateFile(filePath);

              // -- Assert --
              expect(result).toBeFalsy();
            });
          });
        }
      });
    });

    describe("file not found", () => {
      it("should throw an error", () => {
        // -- Arrange --
        const invalidPath = path.join(os.tmpdir(), "invalid-path");

        // -- Act & Assert --
        expect(() => exportForTesting.isAppDelegateFile(invalidPath)).toThrow();
      });
    });
  });

  describe("#findAppDidFinishLaunchingWithOptionsInDirectory", () => {
    describe("no files given", () => {
      it("should check files in directory", () => {
        // -- Arrange --
        const tempDir = prepareTempDir();
        const filePath = prepareAppDelegateFile(
          tempDir,
          validAppDelegateSwift,
          "swift",
        );

        // -- Act --
        const result =
          exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
            tempDir,
          );

        // -- Assert --
        expect(result).toBe(filePath);
      });
    });

    describe("SwiftUI file found", () => {
      describe("is app delegate", () => {
        it("should return the file path", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          const filePath = prepareAppDelegateFile(
            tempDir,
            validAppDelegateSwiftUI,
            "swift",
          );

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBe(filePath);
        });
      });

      describe("is not app delegate", () => {
        it("should be ignored", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          prepareAppDelegateFile(tempDir, invalidAppDelegateSwiftUI, "swift");

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBeNull();
        });
      });
    });

    describe("Swift file found", () => {
      describe("is app delegate", () => {
        it("should return the file path", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          const filePath = prepareAppDelegateFile(
            tempDir,
            validAppDelegateSwift,
            "swift",
          );

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBe(filePath);
        });
      });

      describe("is not app delegate", () => {
        it("should be ignored", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          prepareAppDelegateFile(tempDir, invalidAppDelegateSwift, "swift");

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBeNull();
        });
      });
    });

    describe("Objective-C file found", () => {
      describe("is app delegate", () => {
        it("should return the file path", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          const filePath = prepareAppDelegateFile(
            tempDir,
            validAppDelegateObjC,
            "m",
          );

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBe(filePath);
        });
      });

      describe("is not app delegate", () => {
        it("should be ignored", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          prepareAppDelegateFile(tempDir, invalidAppDelegateObjC, "m");

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBeNull();
        });
      });
    });

    describe("Objective-C++ file found", () => {
      describe("is app delegate", () => {
        it("should return the file path", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          const filePath = prepareAppDelegateFile(
            tempDir,
            validAppDelegateObjC,
            "mm",
          );

          // -- Act --
          const result = exportForTesting.findAppDidFinishLaunchingWithOptions([
            filePath,
          ]);

          // -- Assert --
          expect(result).toBe(filePath);
        });
      });

      describe("is not app delegate", () => {
        it("should be ignored", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          prepareAppDelegateFile(tempDir, invalidAppDelegateObjC, "mm");

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBeNull();
        });
      });
    });

    describe("file in list not found", () => {
      it("should return null", () => {
        // -- Arrange --
        const tempDir = prepareTempDir();
        const filePath = prepareAppDelegateFile(
          tempDir,
          invalidAppDelegateSwift,
          "swift",
        );

        // -- Act --
        const result = exportForTesting.findAppDidFinishLaunchingWithOptions([
          filePath,
        ]);

        // -- Assert --
        expect(result).toBeNull();
      });
    });

    describe("unrelated file found", () => {
      it("should be ignored", () => {
        // -- Arrange --
        const tempDir = prepareTempDir();
        const filePath = prepareAppDelegateFile(
          tempDir,
          invalidAppDelegateSwift,
          "swift",
        );

        // -- Act --
        const result = exportForTesting.findAppDidFinishLaunchingWithOptions([
          filePath,
        ]);

        // -- Assert --
        expect(result).toBeNull();
      });
    });

    describe("directory in list", () => {
      describe("name starts with dot", () => {
        it("should be ignored", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();

          const hiddenDir = path.join(tempDir, ".hidden");
          fs.mkdirSync(hiddenDir);

          prepareAppDelegateFile(hiddenDir, validAppDelegateSwift, "swift");

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBeNull();
        });
      });

      describe("name ends with .xcodeproj", () => {
        it("should be ignored", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          const xcodeDir = path.join(tempDir, "MyProject.xcodeproj");
          fs.mkdirSync(xcodeDir);

          prepareAppDelegateFile(xcodeDir, validAppDelegateSwift, "swift");

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBeNull();
        });
      });

      describe("name ends with .xcassets", () => {
        it("should be ignored", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          const xcassetsDir = path.join(tempDir, "MyProject.xcassets");
          fs.mkdirSync(xcassetsDir);

          prepareAppDelegateFile(xcassetsDir, validAppDelegateSwift, "swift");

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBeNull();
        });
      });

      describe("is not a directory", () => {
        it("should be ignored", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          const filePath = path.join(tempDir, "some-file");
          fs.writeFileSync(filePath, validAppDelegateSwift, "utf8");

          // -- Act --
          const result =
            exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
              tempDir,
            );

          // -- Assert --
          expect(result).toBeNull();
        });
      });
    });

    describe("multiple files could be app delegate", () => {
      it("should return the first one", () => {
        // -- Arrange --
        const tempDir = prepareTempDir();
        const filePath = prepareAppDelegateFile(
          tempDir,
          validAppDelegateSwift,
          "swift",
        );
        prepareAppDelegateFile(tempDir, validAppDelegateSwift, "swift");

        // -- Act --
        const result =
          exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
            tempDir,
          );

        // -- Assert --
        expect(result).toBe(filePath);
      });
    });

    describe("multiple nested directories with app delegate", () => {
      it("should return the first one", () => {
        // -- Arrange --
        const tempDir = prepareTempDir();

        const nestedDir = path.join(tempDir, "nested");
        fs.mkdirSync(nestedDir);
        const nestedFilePath = prepareAppDelegateFile(
          nestedDir,
          validAppDelegateSwift,
          "swift",
        );

        const nestedDir2 = path.join(tempDir, "nested2");
        fs.mkdirSync(nestedDir2);
        prepareAppDelegateFile(nestedDir2, validAppDelegateSwift, "swift");

        // -- Act --
        const result =
          exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
            tempDir,
          );

        // -- Assert --
        expect(result).toBe(nestedFilePath);
      });
    });

    describe("no app delegate found", () => {
      it("should return null", () => {
        // -- Arrange --
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "code-tools-test"),
        );

        // -- Act --
        const result =
          exportForTesting.findAppDidFinishLaunchingWithOptionsInDirectory(
            tempDir,
          );

        // -- Assert --
        expect(result).toBeNull();
      });
    });
  });

  describe("#addCodeSnippetToProject", () => {
    describe("app delegate file is not found", () => {
      it("should return false", () => {
        // -- Act --
        const result = addCodeSnippetToProject(
          ["AppDelegate.swift"],
          "https://example.com/sentry-dsn",
          false,
        );

        // -- Assert --
        expect(result).toBeFalsy();
      });
    });

    describe("app delegate file is found", () => {
      let tempDir: string;
      let appDelegatePath: string;

      beforeEach(() => {
        // -- Arrange --
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-tools-test"));
        appDelegatePath = path.join(tempDir, "AppDelegate.swift");
        fs.writeFileSync(appDelegatePath, validAppDelegateSwift, "utf8");
      });

      describe("is Swift file", () => {
        describe("Sentry is not initialized", () => {
          let tempDir: string;
          let filePath: string;

          beforeEach(() => {
            tempDir = prepareTempDir();
            filePath = prepareAppDelegateFile(
              tempDir,
              validAppDelegateSwift,
              "swift",
            );
          });

          it("should add the code snippet", () => {
            // -- Act --
            const result = addCodeSnippetToProject([filePath], dsn, false);

            // -- Assert --
            expect(result).toBeTruthy();
            const modifiedFileContent = fs.readFileSync(filePath, "utf8");
            expect(modifiedFileContent).toBe(validAppDelegateSwiftWithSentry);
          });

          it("should set tag 'code-language'", () => {
            // -- Act --
            const result = addCodeSnippetToProject([filePath], dsn, false);

            // -- Assert --
            expect(result).toBeTruthy();
            expect(setTag).toHaveBeenCalledWith("code-language", "swift");
          });

          it("should set tag 'ui-engine'", () => {
            // -- Act --
            const result = addCodeSnippetToProject([filePath], dsn, false);

            // -- Assert --
            expect(result).toBeTruthy();
            expect(setTag).toHaveBeenCalledWith("ui-engine", "uikit");
          });
        });

        describe("Sentry is already initialized", () => {
          it("should not add the code snippet", () => {
            // -- Arrange --
            const tempDir = prepareTempDir();
            const filePath = prepareAppDelegateFile(
              tempDir,
              validAppDelegateSwiftWithSentry,
              "swift",
            );

            // -- Act --
            const result = addCodeSnippetToProject([filePath], dsn, false);

            // -- Assert --
            expect(result).toBeTruthy();
            const modifiedFileContent = fs.readFileSync(filePath, "utf8");
            expect(modifiedFileContent).toBe(validAppDelegateSwiftWithSentry);
          });
        });

        describe("is SwiftUI file", () => {
          describe("Sentry is not initialized", () => {
            let tempDir: string;
            let filePath: string;

            beforeEach(() => {
              tempDir = prepareTempDir();
              filePath = prepareAppDelegateFile(
                tempDir,
                validAppDelegateSwiftUI,
                "swift",
              );
            });

            it("should add the code snippet", () => {
              // -- Act --
              const result = addCodeSnippetToProject([filePath], dsn, false);

              // -- Assert --
              expect(result).toBeTruthy();
              const modifiedFileContent = fs.readFileSync(filePath, "utf8");
              expect(modifiedFileContent).toBe(
                validAppDelegateSwiftUIWithSentry,
              );
            });

            it("should set tag 'code-language'", () => {
              // -- Act --
              const result = addCodeSnippetToProject([filePath], dsn, false);

              // -- Assert --
              expect(result).toBeTruthy();
              expect(setTag).toHaveBeenNthCalledWith(
                1,
                "code-language",
                "swift",
              );
            });

            it("should set tag 'ui-engine'", () => {
              // -- Act --
              const result = addCodeSnippetToProject([filePath], dsn, false);

              // -- Assert --
              expect(result).toBeTruthy();
              expect(setTag).toHaveBeenNthCalledWith(2, "ui-engine", "swiftui");
            });
          });

          describe("Sentry is already initialized", () => {
            it("should not add the code snippet", () => {
              // -- Arrange --
              const tempDir = prepareTempDir();
              const filePath = prepareAppDelegateFile(
                tempDir,
                validAppDelegateSwiftUIWithSentry,
                "swift",
              );

              // -- Act --
              const result = addCodeSnippetToProject([filePath], dsn, false);

              // -- Assert --
              expect(result).toBeTruthy();
              const modifiedFileContent = fs.readFileSync(filePath, "utf8");
              expect(modifiedFileContent).toBe(
                validAppDelegateSwiftUIWithSentry,
              );
            });
          });

          describe("has existing init() but no Sentry", () => {
            it("should inject into existing init() instead of creating duplicate", () => {
              // -- Arrange --
              const tempDir = prepareTempDir();
              const filePath = prepareAppDelegateFile(
                tempDir,
                validAppDelegateSwiftUIWithExistingInit,
                "swift",
              );

              // -- Act --
              const result = addCodeSnippetToProject([filePath], dsn, false);

              // -- Assert --
              expect(result).toBeTruthy();
              const modifiedFileContent = fs.readFileSync(filePath, "utf8");
              // Should NOT have duplicate init()
              const initCount = (
                modifiedFileContent.match(/init\s*\(\s*\)\s*\{/g) || []
              ).length;
              expect(initCount).toBe(1);
              // Should have Sentry initialized
              expect(modifiedFileContent).toContain("SentrySDK.start");
              // Should preserve existing init() content
              expect(modifiedFileContent).toContain('print("App initialized")');
              // Full content check
              expect(modifiedFileContent).toBe(
                validAppDelegateSwiftUIWithExistingInitAndSentry,
              );
            });
          });
        });

        describe("is not matching SwiftUI regex", () => {
          it("should not add the code snippet", () => {
            // -- Arrange --
            const tempDir = prepareTempDir();
            const filePath = prepareAppDelegateFile(
              tempDir,
              invalidAppDelegateSwiftUI,
              "swift",
            );

            // -- Act --
            const result = addCodeSnippetToProject([filePath], dsn, false);

            // -- Assert --
            expect(result).toBeFalsy();
          });
        });
      });

      describe("is Objective-C file", () => {
        describe("Sentry is not initialized", () => {
          it("should add the code snippet", () => {
            // -- Act --
            const tempDir = prepareTempDir();
            const filePath = prepareAppDelegateFile(
              tempDir,
              validAppDelegateObjC,
              "m",
            );

            // -- Act --
            const result = addCodeSnippetToProject([filePath], dsn, false);

            // -- Assert --
            expect(result).toBeTruthy();
            const modifiedFileContent = fs.readFileSync(filePath, "utf8");
            expect(modifiedFileContent).toBe(validAppDelegateObjCWithSentry);
          });
        });

        describe("Sentry is already initialized", () => {
          let tempDir: string;
          let filePath: string;

          beforeEach(() => {
            tempDir = prepareTempDir();
            filePath = prepareAppDelegateFile(
              tempDir,
              validAppDelegateObjCWithSentry,
              "m",
            );
          });

          it("should not add the code snippet", () => {
            // -- Act --
            const result = addCodeSnippetToProject([filePath], dsn, false);

            // -- Assert --
            expect(result).toBeTruthy();
            const modifiedFileContent = fs.readFileSync(filePath, "utf8");
            expect(modifiedFileContent).toBe(validAppDelegateObjCWithSentry);
          });

          it("should log info", () => {
            // -- Act --
            const result = addCodeSnippetToProject([filePath], dsn, false);

            // -- Assert --
            expect(result).toBeTruthy();
            expect(clack.log.info).toHaveBeenCalledWith(
              "Sentry is already initialized in your AppDelegate. Skipping adding the code snippet.",
            );
          });
        });

        it("should set tag 'code-language'", () => {
          // -- Arrange --
          const tempDir = prepareTempDir();
          const filePath = prepareAppDelegateFile(
            tempDir,
            validAppDelegateObjC,
            "m",
          );

          // -- Act --
          const result = addCodeSnippetToProject([filePath], dsn, false);

          // -- Assert --
          expect(result).toBeTruthy();
          expect(setTag).toHaveBeenCalledWith("code-language", "objc");
        });
      });
    });

    describe("with logs enabled", () => {
      it("should add logs option to Swift file", () => {
        // -- Arrange --
        const tempDir = prepareTempDir();
        const filePath = prepareAppDelegateFile(
          tempDir,
          validAppDelegateSwift,
          "swift",
        );

        // -- Act --
        const result = addCodeSnippetToProject([filePath], dsn, true);

        // -- Assert --
        expect(result).toBeTruthy();
        const fileContent = fs.readFileSync(filePath, "utf8");
        expect(fileContent).toContain("options.experimental.enableLogs = true");
      });

      it("should add logs option to Objective-C file", () => {
        // -- Arrange --
        const tempDir = prepareTempDir();
        const filePath = prepareAppDelegateFile(
          tempDir,
          validAppDelegateObjC,
          "m",
        );

        // -- Act --
        const result = addCodeSnippetToProject([filePath], dsn, true);

        // -- Assert --
        expect(result).toBeTruthy();
        const fileContent = fs.readFileSync(filePath, "utf8");
        expect(fileContent).toContain("options.experimental.enableLogs = YES;");
      });
    });

    describe("with logs disabled", () => {
      it("should not add logs option to Swift file", () => {
        // -- Arrange --
        const tempDir = prepareTempDir();
        const filePath = prepareAppDelegateFile(
          tempDir,
          validAppDelegateSwift,
          "swift",
        );

        // -- Act --
        const result = addCodeSnippetToProject([filePath], dsn, false);

        // -- Assert --
        expect(result).toBeTruthy();
        const fileContent = fs.readFileSync(filePath, "utf8");
        expect(fileContent).not.toContain(
          "options.experimental.enableLogs = true",
        );
      });

      it("should not add logs option to Objective-C file", () => {
        // -- Arrange --
        const tempDir = prepareTempDir();
        const filePath = prepareAppDelegateFile(
          tempDir,
          validAppDelegateObjC,
          "m",
        );

        // -- Act --
        const result = addCodeSnippetToProject([filePath], dsn, false);

        // -- Assert --
        expect(result).toBeTruthy();
        const fileContent = fs.readFileSync(filePath, "utf8");
        expect(fileContent).not.toContain(
          "options.experimental.enableLogs = YES;",
        );
      });
    });
  });
});
