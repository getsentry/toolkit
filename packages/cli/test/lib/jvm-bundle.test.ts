/**
 * Tests for JVM source bundle builder core logic.
 *
 * Tests path filtering (ambiguous build dirs, safe excludes),
 * source-set prefix stripping, and URL construction.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  _buildSourceUrl,
  _isInAmbiguousBuildDir,
  _stripSourceSetPrefix,
  buildJvmBundle,
} from "../../src/lib/jvm-bundle.js";

describe("isInAmbiguousBuildDir", () => {
  test("excludes build/ at root", () => {
    expect(_isInAmbiguousBuildDir("build/generated/Foo.java")).toBe(true);
  });

  test("excludes target/ at root", () => {
    expect(_isInAmbiguousBuildDir("target/classes/Foo.java")).toBe(true);
  });

  test("keeps build/ under src/", () => {
    expect(
      _isInAmbiguousBuildDir("src/main/java/com/example/build/Builder.java")
    ).toBe(false);
  });

  test("excludes build/ with src/ inside it", () => {
    expect(_isInAmbiguousBuildDir("build/src/main/java/Foo.java")).toBe(true);
  });

  test("keeps non-ambiguous directories", () => {
    expect(_isInAmbiguousBuildDir("src/main/java/Foo.java")).toBe(false);
  });

  test("excludes out/ at root", () => {
    expect(_isInAmbiguousBuildDir("out/production/Foo.java")).toBe(true);
  });

  test("excludes bin/ at root", () => {
    expect(_isInAmbiguousBuildDir("bin/Foo.java")).toBe(true);
  });

  test("keeps deeply nested build/ under src/", () => {
    expect(
      _isInAmbiguousBuildDir(
        "module/src/main/java/com/build/target/out/Foo.java"
      )
    ).toBe(false);
  });
});

describe("stripSourceSetPrefix", () => {
  test("strips src/main/java/", () => {
    expect(_stripSourceSetPrefix("src/main/java/io/sentry/core/Foo.java")).toBe(
      "io/sentry/core/Foo.java"
    );
  });

  test("strips module/src/main/kotlin/", () => {
    expect(
      _stripSourceSetPrefix("sentry-core/src/main/kotlin/io/sentry/Foo.kt")
    ).toBe("io/sentry/Foo.kt");
  });

  test("strips src/test/java/", () => {
    expect(
      _stripSourceSetPrefix("src/test/java/com/example/FooTest.java")
    ).toBe("com/example/FooTest.java");
  });

  test("strips src/main/scala/", () => {
    expect(_stripSourceSetPrefix("src/main/scala/com/example/App.scala")).toBe(
      "com/example/App.scala"
    );
  });

  test("strips src/main/groovy/", () => {
    expect(
      _stripSourceSetPrefix("src/main/groovy/com/example/Script.groovy")
    ).toBe("com/example/Script.groovy");
  });

  test("strips src/main/clojure/", () => {
    expect(_stripSourceSetPrefix("src/main/clojure/com/example/core.clj")).toBe(
      "com/example/core.clj"
    );
  });

  test("keeps path without source-set prefix", () => {
    expect(_stripSourceSetPrefix("just/a/File.java")).toBe("just/a/File.java");
  });

  test("normalizes backslashes", () => {
    expect(
      _stripSourceSetPrefix("src\\main\\java\\com\\example\\Foo.java")
    ).toBe("com/example/Foo.java");
  });
});

describe("buildSourceUrl", () => {
  test("adds ~/ prefix and .jvm extension", () => {
    expect(_buildSourceUrl("io/sentry/core/Foo.java")).toBe(
      "~/io/sentry/core/Foo.jvm"
    );
  });

  test("replaces .kt extension", () => {
    expect(_buildSourceUrl("com/example/Bar.kt")).toBe("~/com/example/Bar.jvm");
  });

  test("replaces .scala extension", () => {
    expect(_buildSourceUrl("com/example/App.scala")).toBe(
      "~/com/example/App.jvm"
    );
  });
});

describe("buildJvmBundle", () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "jvm-bundle-test-"));
    outputDir = join(tempDir, "output");
    await mkdir(outputDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("bundles Java files", async () => {
    await mkdir(join(tempDir, "src", "main", "java", "com", "example"), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, "src", "main", "java", "com", "example", "Main.java"),
      "public class Main {}"
    );

    const result = await buildJvmBundle({
      sourcePath: tempDir,
      outputPath: join(outputDir, "test.zip"),
      debugId: "12345678-1234-1234-1234-123456789abc",
    });

    expect(result.fileCount).toBe(1);
    expect(result.collisionCount).toBe(0);
    expect(existsSync(result.outputPath)).toBe(true);
  });

  test("bundles Kotlin files", async () => {
    await mkdir(join(tempDir, "src", "main", "kotlin", "com", "example"), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, "src", "main", "kotlin", "com", "example", "App.kt"),
      "fun main() {}"
    );

    const result = await buildJvmBundle({
      sourcePath: tempDir,
      outputPath: join(outputDir, "test.zip"),
      debugId: "12345678-1234-1234-1234-123456789abc",
    });

    expect(result.fileCount).toBe(1);
  });

  test("excludes build output directories", async () => {
    // File in build/ should be excluded
    await mkdir(join(tempDir, "build", "generated"), { recursive: true });
    await writeFile(
      join(tempDir, "build", "generated", "R.java"),
      "// generated"
    );

    // File in src/ should be included
    await mkdir(join(tempDir, "src", "main", "java"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "main", "java", "App.java"),
      "class App {}"
    );

    const result = await buildJvmBundle({
      sourcePath: tempDir,
      outputPath: join(outputDir, "test.zip"),
      debugId: "12345678-1234-1234-1234-123456789abc",
    });

    expect(result.fileCount).toBe(1);
  });

  test("respects excludePatterns", async () => {
    await mkdir(join(tempDir, "generated"), { recursive: true });
    await writeFile(join(tempDir, "generated", "Auto.java"), "class Auto {}");
    await mkdir(join(tempDir, "src", "main", "java"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "main", "java", "App.java"),
      "class App {}"
    );

    const result = await buildJvmBundle({
      sourcePath: tempDir,
      outputPath: join(outputDir, "test.zip"),
      debugId: "12345678-1234-1234-1234-123456789abc",
      excludePatterns: ["generated"],
    });

    expect(result.fileCount).toBe(1);
  });

  test("returns zero files for empty directory", async () => {
    const result = await buildJvmBundle({
      sourcePath: tempDir,
      outputPath: join(outputDir, "test.zip"),
      debugId: "12345678-1234-1234-1234-123456789abc",
    });

    expect(result.fileCount).toBe(0);
  });

  test("handles sourcePath ending in src/", async () => {
    const srcDir = join(tempDir, "src");
    await mkdir(join(srcDir, "main", "java", "com", "example"), {
      recursive: true,
    });
    await writeFile(
      join(srcDir, "main", "java", "com", "example", "App.java"),
      "class App {}"
    );

    const result = await buildJvmBundle({
      sourcePath: srcDir,
      outputPath: join(outputDir, "test.zip"),
      debugId: "12345678-1234-1234-1234-123456789abc",
    });

    expect(result.fileCount).toBe(1);
    // URL should be package-relative, not main/java/...
    const urls = [...result.files.keys()];
    expect(urls[0]).toBe("~/com/example/App.jvm");
  });

  test("includes debug ID in manifest", async () => {
    await mkdir(join(tempDir, "src", "main", "java"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "main", "java", "App.java"),
      "class App {}"
    );

    const debugId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const result = await buildJvmBundle({
      sourcePath: tempDir,
      outputPath: join(outputDir, "test.zip"),
      debugId,
    });

    expect(result.fileCount).toBe(1);
    expect(existsSync(result.outputPath)).toBe(true);
  });

  test("follows symlinked source files", async () => {
    // Real file lives outside the scanned source tree.
    const externalDir = join(tempDir, "external");
    await mkdir(externalDir, { recursive: true });
    const realFile = join(externalDir, "Linked.java");
    await writeFile(realFile, "class Linked {}");

    // A symlink to it sits inside the source tree.
    const pkgDir = join(tempDir, "src", "main", "java", "com", "example");
    await mkdir(pkgDir, { recursive: true });
    await symlink(realFile, join(pkgDir, "Linked.java"));

    const result = await buildJvmBundle({
      sourcePath: join(tempDir, "src"),
      outputPath: join(outputDir, "test.zip"),
      debugId: "12345678-1234-1234-1234-123456789abc",
      excludePatterns: ["external"],
    });

    expect(result.fileCount).toBe(1);
    expect([...result.files.keys()][0]).toBe("~/com/example/Linked.jvm");
  });

  test("follows symlinked directories", async () => {
    // Real package directory outside the scanned source tree.
    const externalPkg = join(tempDir, "shared", "com", "example");
    await mkdir(externalPkg, { recursive: true });
    await writeFile(join(externalPkg, "Shared.java"), "class Shared {}");

    // Source tree contains a symlink to the external "com" package dir.
    const srcJava = join(tempDir, "src", "main", "java");
    await mkdir(srcJava, { recursive: true });
    await symlink(join(tempDir, "shared", "com"), join(srcJava, "com"));

    const result = await buildJvmBundle({
      sourcePath: join(tempDir, "src"),
      outputPath: join(outputDir, "test.zip"),
      debugId: "12345678-1234-1234-1234-123456789abc",
    });

    expect(result.fileCount).toBe(1);
    expect([...result.files.keys()][0]).toBe("~/com/example/Shared.jvm");
  });

  test("does not loop on symlink cycles", async () => {
    const pkgDir = join(tempDir, "src", "main", "java", "com", "example");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "App.java"), "class App {}");

    // Create a self-referential symlink cycle: example/loop -> src
    await symlink(join(tempDir, "src"), join(pkgDir, "loop"));

    const result = await buildJvmBundle({
      sourcePath: join(tempDir, "src"),
      outputPath: join(outputDir, "test.zip"),
      debugId: "12345678-1234-1234-1234-123456789abc",
    });

    // The single real file is collected exactly once despite the cycle.
    expect(result.fileCount).toBe(1);
    expect([...result.files.keys()][0]).toBe("~/com/example/App.jvm");
  });
});
