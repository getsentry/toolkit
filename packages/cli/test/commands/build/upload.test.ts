/**
 * Tests for `sentry build upload`.
 *
 * Drives the command through its wrapper `loader()`. Real detection +
 * normalization run against in-memory ZIP fixtures (a "fake APK" is a ZIP with
 * an AndroidManifest.xml entry); the API `uploadBuild` and org/project
 * resolution are spied so no network is touched.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../../../src/app.js";
import { uploadCommand } from "../../../src/commands/build/upload.js";
import type { SentryContext } from "../../../src/context.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as preprod from "../../../src/lib/api/preprod-artifacts.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("build-upload-cmd-");

let tmpDir: string;

function createContext() {
  const writes: string[] = [];
  return {
    context: {
      stdout: {
        write: (data: string | Uint8Array) => {
          writes.push(
            typeof data === "string" ? data : new TextDecoder().decode(data)
          );
          return true;
        },
      },
      stderr: { write: () => true },
      cwd: tmpDir,
      env: {} as NodeJS.ProcessEnv,
      process: { ...process, exitCode: undefined } as typeof process,
    },
    output: () => writes.join(""),
    get exitCode() {
      return this.context.process.exitCode;
    },
  };
}

/** Write a fake APK (a ZIP with a root AndroidManifest.xml) to the temp dir. */
async function writeApk(name = "app-release.apk"): Promise<string> {
  const path = join(tmpDir, name);
  await writeFile(path, zipSync({ "AndroidManifest.xml": strToU8("xml") }));
  return path;
}

/**
 * Run the command through the real Stricli parser + router (unlike the
 * `loader()` tests, this exercises flag arity). Returns captured stderr +
 * exit code.
 */
async function runViaApp(
  args: string[]
): Promise<{ stderr: string; exitCode: number | undefined }> {
  let stderr = "";
  const context: SentryContext = {
    process: { ...process, exitCode: undefined } as typeof process,
    env: {} as NodeJS.ProcessEnv,
    cwd: tmpDir,
    homeDir: tmpDir,
    configDir: tmpDir,
    stdout: { write: () => true },
    stderr: {
      write: (data: string | Uint8Array) => {
        stderr += typeof data === "string" ? data : new TextDecoder().decode(data);
        return true;
      },
    },
    stdin: process.stdin,
  };
  await run(app, ["build", "upload", ...args], context);
  return { stderr, exitCode: context.process.exitCode };
}

describe("build upload", () => {
  let uploadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "build-upload-"));
    setAuthToken("test-token", 3600);
    vi.spyOn(resolveTarget, "resolveOrgAndProject").mockResolvedValue({
      org: "test-org",
      project: "test-project",
    });
    uploadSpy = vi
      .spyOn(preprod, "uploadBuild")
      .mockResolvedValue("https://sentry.io/artifact/1");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("uploads an APK and reports the artifact URL", async () => {
    const apk = await writeApk();
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, {}, apk);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const opts = uploadSpy.mock.calls[0]?.[0] as { org: string; project: string };
    expect(opts.org).toBe("test-org");
    expect(opts.project).toBe("test-project");
    expect(harness.output()).toContain("https://sentry.io/artifact/1");
    expect(harness.exitCode).toBeUndefined();
  });

  test("passes build metadata flags through to the API", async () => {
    const apk = await writeApk();
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(
      harness.context,
      {
        "build-configuration": "Release",
        "install-group": ["qa", "beta"],
      },
      apk
    );

    const meta = uploadSpy.mock.calls[0]?.[0] as {
      metadata: { buildConfiguration?: string; installGroups?: string[] };
    };
    expect(meta.metadata.buildConfiguration).toBe("Release");
    expect(meta.metadata.installGroups).toEqual(["qa", "beta"]);
  });

  test("folds explicit git-metadata flags into the assemble body", async () => {
    const apk = await writeApk();
    const harness = createContext();
    const func = await uploadCommand.loader();

    const sha = "abcdef01".repeat(5); // 40 hex chars
    await func.call(
      harness.context,
      { "head-sha": sha, "head-ref": "main", "pr-number": 9 },
      apk
    );

    const meta = uploadSpy.mock.calls[0]?.[0] as {
      metadata: { vcs?: Record<string, unknown> };
    };
    // env has no CI vars, so only explicit flags are collected.
    expect(meta.metadata.vcs).toEqual({
      head_sha: sha,
      head_ref: "main",
      pr_number: 9,
    });
  });

  test("rejects an unsupported file with a non-zero exit", async () => {
    const bad = join(tmpDir, "notes.txt");
    await writeFile(bad, "not a build");
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, {}, bad);

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(harness.exitCode).toBe(1);
    expect(harness.output()).toContain("Unsupported build format");
  });

  /** Write a minimal valid XCArchive directory; returns its path. */
  async function writeXcarchive(name = "MyApp.xcarchive"): Promise<string> {
    const dir = join(tmpDir, name);
    const app = join(dir, "Products", "Applications", "MyApp.app");
    await mkdir(app, { recursive: true });
    await writeFile(join(dir, "Info.plist"), "<plist/>");
    await writeFile(join(app, "Info.plist"), "<app/>");
    await writeFile(join(app, "MyApp"), "binary");
    return dir;
  }

  test("uploads an XCArchive directory", async () => {
    const dir = await writeXcarchive();
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, {}, dir);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(harness.exitCode).toBeUndefined();
    expect(harness.output()).toContain("https://sentry.io/artifact/1");
  });

  test("rejects a directory that is not a valid XCArchive", async () => {
    const dir = join(tmpDir, "not-an-archive");
    await mkdir(dir);
    await writeFile(join(dir, "readme.txt"), "hello");
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, {}, dir);

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(harness.exitCode).toBe(1);
    expect(harness.output()).toContain("Invalid XCArchive");
  });

  test("uploads an IPA (converted to an XCArchive layout)", async () => {
    const ipa = join(tmpDir, "MyApp.ipa");
    await writeFile(
      ipa,
      zipSync({
        "Payload/MyApp.app/Info.plist": strToU8("<app/>"),
        "Payload/MyApp.app/MyApp": strToU8("binary"),
      })
    );
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, {}, ipa);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(harness.exitCode).toBeUndefined();
  });

  test("uploads the good build but exits non-zero when another fails", async () => {
    const apk = await writeApk("good.apk");
    const bad = join(tmpDir, "bad.txt");
    await writeFile(bad, "nope");
    const harness = createContext();
    const func = await uploadCommand.loader();

    await func.call(harness.context, {}, apk, bad);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(harness.exitCode).toBe(1);
  });

  // Regression guard: --install-group must be OPTIONAL. Declared variadic
  // without `optional: true`, Stricli treats it as required and the common
  // `build upload <path>` invocation fails at parse time. This drives the real
  // parser (the loader() tests above bypass it), so it catches flag arity.
  test("accepts a build with no --install-group (flag is optional)", async () => {
    const apk = await writeApk();

    const { stderr, exitCode } = await runViaApp([apk]);

    // Parsing succeeded and dispatched to the command (which uploaded).
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(exitCode ?? 0).toBe(0);
    expect(stderr).not.toMatch(/install-group/i);
  });
});
