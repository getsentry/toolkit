import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addGradlePlugin,
  getNamespace,
} from "../../../../src/lib/wizard/android/gradle.js";
import {
  pluginKts,
  pluginsBlock,
  sourceContext,
  sourceContextKts,
} from "../../../../src/lib/wizard/android/templates.js";
import { execute } from "../../../../src/lib/wizard/utils/bash.js";

vi.mock("../../../../src/lib/error-reporting.js", () => ({
  reportCliError: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/utils/bash.js", () => ({
  execute: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/utils/release-registry.js", () => ({
  fetchSdkVersion: vi.fn().mockResolvedValue("5.0.0"),
}));

describe("gradle", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.mocked(execute).mockResolvedValue("");
    tmpDir = mkdtempSync(path.join(tmpdir(), "android-gradle-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
    vi.restoreAllMocks();
  });

  function writeGradle(name: string, content: string): string {
    const file = path.join(tmpDir, name);
    writeFileSync(file, content);
    return file;
  }

  describe("getNamespace", () => {
    it.each([
      ["Groovy", `android {\n    namespace 'com.example.groovy'\n}`],
      ["Kotlin", `android {\n    namespace = "com.example.groovy"\n}`],
    ])("reads the namespace of a %s script", (_label, content) => {
      const file = writeGradle("build.gradle", content);

      expect(getNamespace(file)).toBe("com.example.groovy");
    });

    it("returns undefined without a namespace", () => {
      const file = writeGradle("build.gradle", "android {}");

      expect(getNamespace(file)).toBeUndefined();
    });
  });

  describe("addGradlePlugin", () => {
    it("adds the plugin to an existing plugins block and a sentry block", async () => {
      const original = `plugins {
    id("com.android.application")
}

android {
    namespace = "com.example"
}
`;
      const file = writeGradle("build.gradle.kts", original);

      await expect(addGradlePlugin(file, "my-org", "my-app")).resolves.toBe(
        true,
      );

      const insertAt = original.indexOf("}");
      expect(readFileSync(file, "utf8")).toBe(
        original.slice(0, insertAt) +
          pluginKts("5.0.0") +
          original.slice(insertAt) +
          sourceContextKts("my-org", "my-app"),
      );
      expect(execute).toHaveBeenCalledWith("./gradlew");
    });

    it("verifies with gradlew.bat on Windows", async () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const file = writeGradle(
        "build.gradle.kts",
        `plugins {\n    id("com.android.application")\n}\n`,
      );

      await addGradlePlugin(file, "my-org", "my-app");

      expect(execute).toHaveBeenCalledWith("gradlew.bat");
    });

    it("adds a plugins block after the imports when there is none", async () => {
      const original = `import groovy.json.JsonSlurper

apply plugin: 'com.android.application'
`;
      const file = writeGradle("build.gradle", original);

      await addGradlePlugin(file, "my-org", "my-app");

      const insertAt = original.indexOf("\n") + 1;
      expect(readFileSync(file, "utf8")).toBe(
        original.slice(0, insertAt) +
          pluginsBlock("5.0.0") +
          original.slice(insertAt) +
          sourceContext("my-org", "my-app"),
      );
    });

    it("keeps an existing sentry block when the plugin is already there", async () => {
      const original = `plugins {
    id 'io.sentry.android.gradle' version '4.0.0'
}

sentry {
    includeSourceContext = false
}
`;
      const file = writeGradle("build.gradle", original);

      await expect(addGradlePlugin(file, "my-org", "my-app")).resolves.toBe(
        true,
      );

      expect(readFileSync(file, "utf8")).toBe(original);
      expect(execute).not.toHaveBeenCalled();
    });

    it("fails when ./gradlew fails, keeping the edit", async () => {
      vi.mocked(execute).mockRejectedValue(new Error("build failed"));
      const file = writeGradle(
        "build.gradle",
        `plugins {\n    id 'com.android.application'\n}\n`,
      );

      await expect(addGradlePlugin(file, "my-org", "my-app")).resolves.toBe(
        false,
      );
      expect(readFileSync(file, "utf8")).toContain("io.sentry.android.gradle");
    });
  });
});
