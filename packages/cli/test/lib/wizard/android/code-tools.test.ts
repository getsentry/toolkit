import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findActivitySourceFile,
  getLastImportLineLocation,
  patchMainActivity,
} from "../../../../src/lib/wizard/android/code-tools.js";

describe("code-tools", () => {
  describe("getLastImportLineLocation", () => {
    it("returns proper line index", () => {
      const code = `import a.b.c;\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns the line after the package declaration when there are no imports", () => {
      const code =
        `package com.example\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when static import is used", () => {
      const code =
        `import static a.b.c;\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when wildcard import is used", () => {
      const code = `import a.b.*\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when alias import is used", () => {
      const code =
        `import static a.b.c as d\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when multiple imports are present", () => {
      const code =
        `import static a.b.c as d\n` +
        `import a.b.*\n` +
        `import static a.b.c;\n` +
        `import a.b.c;\n` +
        `//<insert-location>\n` +
        `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });
  });

  describe("findActivitySourceFile", () => {
    it.each([
      ["a relative name", ".MainActivity"],
      ["a name without a dot", "MainActivity"],
      ["a fully qualified name", "com.example.MainActivity"],
    ])("finds the activity from %s", async (_label, activityName) => {
      const appDir = mkdtempSync(path.join(tmpdir(), "android-activity-test-"));
      try {
        const dir = path.join(appDir, "src", "main", "java", "com", "example");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "MainActivity.kt"), "");

        await expect(
          findActivitySourceFile(appDir, "com.example", activityName),
        ).resolves.toBe(path.join(dir, "MainActivity.kt"));
      } finally {
        rmSync(appDir, { recursive: true });
      }
    });
  });

  describe("patchMainActivity", () => {
    it("adds the Sentry import when only other io.sentry classes are imported", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "android-patch-test-"));
      try {
        const file = path.join(dir, "MainActivity.kt");
        writeFileSync(
          file,
          "package com.example\n\nimport io.sentry.SentryOptions\n\nclass MainActivity : Activity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(savedInstanceState)\n  }\n}\n",
        );

        expect(patchMainActivity(file)).toBe(true);
        expect(readFileSync(file, "utf8")).toMatch(
          /^import io\.sentry\.Sentry$/m,
        );
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });
});
