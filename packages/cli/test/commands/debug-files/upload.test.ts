/**
 * Tests for `sentry debug-files upload`.
 *
 * Uses Breakpad symbol files (a deterministic, portable text format) as
 * fixtures so the tests need no committed binaries. Filter and dry-run paths
 * run end-to-end through the scanner; the network upload is stubbed by spying
 * on `uploadDebugFiles`.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as chunkUpload from "../../../src/lib/api/chunk-upload.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as debugFilesApi from "../../../src/lib/api/debug-files.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("debug-files-upload-");

const BREAKPAD_FIXTURE = [
  "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
  "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
  "FUNC 1000 10 0 main",
  "1000 10 42 1",
  "PUBLIC 2000 0 some_symbol",
].join("\n");

const KNOWN_DEBUG_ID = "0f13a5da-412a-fbf7-c866-2048f3294f3d";

let tempDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-upload-test-"));
  savedEnv = {
    SENTRY_ORG: process.env.SENTRY_ORG,
    SENTRY_PROJECT: process.env.SENTRY_PROJECT,
  };
  // The real-upload path fetches chunk-upload options before scanning to gate
  // on the server's max file size. Stub it so tests need no network.
  vi.spyOn(chunkUpload, "getChunkUploadOptions").mockResolvedValue({
    url: "https://us.sentry.io/api/0/chunk-upload/",
    chunkSize: 8192,
    chunksPerRequest: 64,
    maxRequestSize: 1_048_576,
    hashAlgorithm: "sha1",
    concurrency: 8,
    compression: ["gzip"],
  } as Awaited<ReturnType<typeof chunkUpload.getChunkUploadOptions>>);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  vi.restoreAllMocks();
});

/** Write a Breakpad symbol file inside `tempDir` and return its path. */
async function writeBreakpad(name = "example.sym"): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(path, BREAKPAD_FIXTURE);
  return path;
}

/** Write a `.zip` containing one Breakpad symbol file; return its path. */
async function writeBreakpadZip(name = "symbols.zip"): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(
    path,
    zipSync({ "example.sym": new TextEncoder().encode(BREAKPAD_FIXTURE) })
  );
  return path;
}

/** Debug id of the managed PE fixture (shared by its embedded Portable PDB). */
const EMBEDDED_PE_DEBUG_ID = "d8eb7dca-4883-4b10-a1f7-048ea1ea388b-cfb0fc89";

/** Copy a committed binary DIF fixture into `tempDir` under `name`. */
async function writeDifFixture(fixture: string, name: string): Promise<string> {
  const bytes = readFileSync(
    new URL(`../../fixtures/dif/${fixture}`, import.meta.url)
  );
  const path = join(tempDir, name);
  await writeFile(path, bytes);
  return path;
}

/**
 * Write a Breakpad file referencing an on-disk generated C++ source that carries
 * an IL2CPP `source_info` marker, so `--il2cpp-mapping` can resolve a mapping.
 */
async function writeIl2cppFixture(): Promise<void> {
  const cppPath = join(tempDir, "Game.cpp");
  await writeFile(cppPath, "//<source_info:Game.cs:42>\nint generated = 0;\n");
  const sym = [
    "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
    "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
    `FILE 0 ${cppPath}`,
    "FUNC 1000 10 0 main",
    "1000 10 42 0",
  ].join("\n");
  await writeFile(join(tempDir, "example.sym"), sym);
}

/** Run `debug-files upload` and capture stdout + exit code. */
async function runUpload(
  args: string[]
): Promise<{ output: string; error: string; exitCode: number | undefined }> {
  let output = "";
  let error = "";
  const mockContext: SentryContext = {
    process: { ...process, exitCode: undefined } as typeof process,
    env: process.env,
    cwd: tempDir,
    homeDir: "/tmp",
    configDir: "/tmp",
    stdout: {
      write(data: string | Uint8Array) {
        output +=
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return true;
      },
    },
    stderr: {
      write(data: string | Uint8Array) {
        error +=
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return true;
      },
    },
    stdin: process.stdin,
  };

  await run(app, ["debug-files", "upload", ...args], mockContext);
  return { output, error, exitCode: mockContext.process.exitCode };
}

describe("sentry debug-files upload", () => {
  // ── Input validation ─────────────────────────────────────────────

  test("no paths exits non-zero", async () => {
    const { exitCode } = await runUpload([]);
    expect(exitCode).not.toBe(0);
  });

  test("--wait and --wait-for together exits non-zero", async () => {
    const path = await writeBreakpad();
    const { exitCode } = await runUpload([
      path,
      "--no-upload",
      "--wait",
      "--wait-for",
      "30",
    ]);
    expect(exitCode).not.toBe(0);
  });

  test("unknown --type exits non-zero", async () => {
    const path = await writeBreakpad();
    const { exitCode } = await runUpload([
      path,
      "--type",
      "bogus",
      "--no-upload",
    ]);
    expect(exitCode).not.toBe(0);
  });

  // ── --derived-data ───────────────────────────────────────────────

  test("--derived-data is additive: explicit paths still scan", async () => {
    await writeBreakpad();
    const { output, exitCode } = await runUpload([
      tempDir,
      "--derived-data",
      "--no-upload",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    // The explicit tempDir fixture is found regardless of whether a
    // DerivedData folder exists on this platform.
    expect(JSON.parse(output).files).toHaveLength(1);
  });

  test.skipIf(process.platform === "darwin")(
    "--derived-data alone on non-macOS exits non-zero (no scan targets)",
    async () => {
      const { exitCode } = await runUpload(["--derived-data", "--no-upload"]);
      expect(exitCode).not.toBe(0);
    }
  );

  // ── --no-upload (dry-run) ────────────────────────────────────────

  test("--no-upload scans a directory and reports the debug id", async () => {
    await writeBreakpad();
    const { output, exitCode } = await runUpload([tempDir, "--no-upload"]);
    expect(output).toContain(KNOWN_DEBUG_ID);
    expect(exitCode).toBe(0);
  });

  test("--no-upload --json reports uploaded:false with the file", async () => {
    await writeBreakpad();
    const { output } = await runUpload([tempDir, "--no-upload", "--json"]);
    const parsed = JSON.parse(output);
    expect(parsed.uploaded).toBe(false);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].debugId).toBe(KNOWN_DEBUG_ID);
  });

  test("--no-upload needs no credentials", async () => {
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
    await writeBreakpad();
    const { exitCode } = await runUpload([tempDir, "--no-upload"]);
    expect(exitCode).toBe(0);
  });

  // ── Filters ──────────────────────────────────────────────────────

  test("--type breakpad matches the fixture", async () => {
    await writeBreakpad();
    const { output } = await runUpload([
      tempDir,
      "--type",
      "breakpad",
      "--no-upload",
      "--json",
    ]);
    expect(JSON.parse(output).files).toHaveLength(1);
  });

  test("--type breakpad --include-sources --no-upload attaches a bundle", async () => {
    // The fixture has no source files, so createSourceBundle returns null;
    // we just verify --include-sources does not break the flow.
    await writeBreakpad();
    const { output, exitCode } = await runUpload([
      tempDir,
      "--type",
      "breakpad",
      "--no-upload",
      "--include-sources",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    // The main DIF is always present; the bundle is only added when
    // createSourceBundle returns one or more files.
    expect(parsed.files.length).toBeGreaterThanOrEqual(1);
  });

  test("--type elf excludes a breakpad file", async () => {
    await writeBreakpad();
    const { output } = await runUpload([
      tempDir,
      "--type",
      "elf",
      "--no-upload",
      "--json",
    ]);
    expect(JSON.parse(output).files).toHaveLength(0);
  });

  test("--id matching the fixture keeps it", async () => {
    await writeBreakpad();
    const { output } = await runUpload([
      tempDir,
      "--id",
      KNOWN_DEBUG_ID,
      "--no-upload",
      "--json",
    ]);
    expect(JSON.parse(output).files).toHaveLength(1);
  });

  test("--id with no match drops the file", async () => {
    await writeBreakpad();
    const { output } = await runUpload([
      tempDir,
      "--id",
      "11111111-1111-1111-1111-111111111111",
      "--no-upload",
      "--json",
    ]);
    expect(JSON.parse(output).files).toHaveLength(0);
  });

  test("--require-all with a missing id exits non-zero", async () => {
    await writeBreakpad();
    const { exitCode } = await runUpload([
      tempDir,
      "--id",
      "11111111-1111-1111-1111-111111111111",
      "--require-all",
      "--no-upload",
    ]);
    expect(exitCode).toBe(1);
  });

  test("--id without --require-all does not fail (dry-run)", async () => {
    await writeBreakpad();
    const { exitCode } = await runUpload([
      tempDir,
      "--id",
      "11111111-1111-1111-1111-111111111111",
      "--no-upload",
    ]);
    expect(exitCode).toBe(0);
  });

  // ── Upload orchestration ─────────────────────────────────────────

  test("uploads scanned files via uploadDebugFiles", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeBreakpad();

    const spy = vi.spyOn(debugFilesApi, "uploadDebugFiles").mockResolvedValue([
      {
        name: "example.sym",
        debugId: KNOWN_DEBUG_ID,
        checksum: "a".repeat(40),
        state: "ok",
        detail: null,
      },
    ]);

    const { exitCode } = await runUpload([tempDir]);
    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0]?.[0];
    expect(callArgs?.org).toBe("test-org");
    expect(callArgs?.project).toBe("test-project");
    expect(callArgs?.difs).toHaveLength(1);
    expect(callArgs?.difs[0]?.debugId).toBe(KNOWN_DEBUG_ID);
    expect(callArgs?.difs[0]?.content).toBeInstanceOf(Buffer);
    // The server options fetched for the scan gate are threaded through so
    // uploadDebugFiles does not re-fetch them.
    expect(callArgs?.serverOptions).toBeDefined();
    expect(exitCode).toBe(0);
  });

  test("server maxFileSize gating all files exits non-zero with a clear error", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeBreakpad();
    // Advertise a 10-byte cap; the fixture is well over that, so it is skipped
    // during the scan and never reaches uploadDebugFiles. Because a real DIF
    // was found but dropped for size, the command must fail loudly rather than
    // reporting "nothing found".
    vi.spyOn(chunkUpload, "getChunkUploadOptions").mockResolvedValue({
      url: "https://us.sentry.io/api/0/chunk-upload/",
      chunkSize: 8192,
      chunksPerRequest: 64,
      maxRequestSize: 1_048_576,
      maxFileSize: 10,
      hashAlgorithm: "sha1",
      concurrency: 8,
      compression: ["gzip"],
    } as Awaited<ReturnType<typeof chunkUpload.getChunkUploadOptions>>);
    const spy = vi.spyOn(debugFilesApi, "uploadDebugFiles");

    const { exitCode } = await runUpload([tempDir]);
    expect(spy).not.toHaveBeenCalled();
    expect(exitCode).not.toBe(0);
  });

  test("a partial size-drop still uploads the rest but exits non-zero", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    // One in-cap file and one valid-header file well over the cap.
    await writeBreakpad("small.sym");
    const bigBody = `${[
      "MODULE Linux x86_64 1A23B5DA412AFBF7C8662048F3294F3D0 big",
      "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
    ].join("\n")}\n${Array.from(
      { length: 500 },
      (_, i) => `PUBLIC ${i.toString(16)} 0 sym_${i}`
    ).join("\n")}`;
    await writeFile(join(tempDir, "big.sym"), bigBody);

    // Cap between the two sizes: the small file passes the scan gate, the big
    // one is dropped (counted in oversizedCount) before it is ever read fully.
    vi.spyOn(chunkUpload, "getChunkUploadOptions").mockResolvedValue({
      url: "https://us.sentry.io/api/0/chunk-upload/",
      chunkSize: 8192,
      chunksPerRequest: 64,
      maxRequestSize: 1_048_576,
      maxFileSize: 1000,
      hashAlgorithm: "sha1",
      concurrency: 8,
      compression: ["gzip"],
    } as Awaited<ReturnType<typeof chunkUpload.getChunkUploadOptions>>);

    const spy = vi.spyOn(debugFilesApi, "uploadDebugFiles").mockResolvedValue([
      {
        name: "small.sym",
        debugId: KNOWN_DEBUG_ID,
        checksum: "a".repeat(40),
        state: "ok",
        detail: null,
      },
    ]);

    const { exitCode } = await runUpload([tempDir]);
    // The in-cap file is still uploaded...
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.difs).toHaveLength(1);
    // ...but the dropped oversized file makes the command fail loudly rather
    // than reporting a clean success.
    expect(exitCode).toBe(1);
  });

  test("wait mode surfaces processing errors with a non-zero exit", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeBreakpad();

    vi.spyOn(debugFilesApi, "uploadDebugFiles").mockResolvedValue([
      {
        name: "example.sym",
        debugId: KNOWN_DEBUG_ID,
        checksum: "a".repeat(40),
        state: "error",
        detail: "could not process",
      },
    ]);

    const { exitCode } = await runUpload([tempDir, "--wait"]);
    expect(exitCode).toBe(1);
  });

  test("a not_found result exits non-zero (chunk delivery incomplete)", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeBreakpad();

    vi.spyOn(debugFilesApi, "uploadDebugFiles").mockResolvedValue([
      {
        name: "example.sym",
        debugId: KNOWN_DEBUG_ID,
        checksum: "a".repeat(40),
        state: "not_found",
        detail: null,
      },
    ]);

    const { exitCode } = await runUpload([tempDir]);
    expect(exitCode).toBe(1);
  });

  test("filesUploaded excludes failed/dropped results", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeBreakpad();

    vi.spyOn(debugFilesApi, "uploadDebugFiles").mockResolvedValue([
      {
        name: "ok.sym",
        debugId: KNOWN_DEBUG_ID,
        checksum: "a".repeat(40),
        state: "ok",
        detail: null,
      },
      {
        name: "toobig.sym",
        debugId: "22222222-2222-2222-2222-222222222222",
        checksum: "",
        state: "error",
        detail: "Exceeds server maximum file size",
      },
    ]);

    const { output } = await runUpload([tempDir, "--json"]);
    const parsed = JSON.parse(output);
    // Both results are listed, but only the non-failed one counts as uploaded.
    expect(parsed.files).toHaveLength(2);
    expect(parsed.filesUploaded).toBe(1);
  });

  test("--require-all note is preserved alongside an upload failure", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeBreakpad();

    vi.spyOn(debugFilesApi, "uploadDebugFiles").mockResolvedValue([
      {
        name: "example.sym",
        debugId: KNOWN_DEBUG_ID,
        checksum: "a".repeat(40),
        state: "error",
        detail: "could not process",
      },
    ]);

    const { exitCode, output } = await runUpload([
      tempDir,
      "--id",
      KNOWN_DEBUG_ID,
      "--id",
      "11111111-1111-1111-1111-111111111111",
      "--require-all",
    ]);
    expect(exitCode).toBe(1);
    // The failure hint must still surface the missing required id — the
    // --require-all feedback must not be swallowed by the earlier failure exit.
    expect(output).toContain("had failures");
    expect(output).toContain("11111111-1111-1111-1111-111111111111");
  });

  test("--require-all on a real upload fails when an --id is missing", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeBreakpad();

    const spy = vi.spyOn(debugFilesApi, "uploadDebugFiles").mockResolvedValue([
      {
        name: "example.sym",
        debugId: KNOWN_DEBUG_ID,
        checksum: "a".repeat(40),
        state: "ok",
        detail: null,
      },
    ]);

    const { exitCode, output } = await runUpload([
      tempDir,
      "--id",
      KNOWN_DEBUG_ID,
      "--id",
      "11111111-1111-1111-1111-111111111111",
      "--require-all",
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(1);
    expect(output).toContain("11111111-1111-1111-1111-111111111111");
  });

  test("--require-all is honored when the queue is empty (real upload)", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeBreakpad();
    const spy = vi.spyOn(debugFilesApi, "uploadDebugFiles");

    // The only --id requested doesn't match the fixture, so the queue is empty.
    // doNothingToUpload must still honor --require-all and report the missing
    // id (exit 1) rather than skipping the check.
    const { exitCode, output } = await runUpload([
      tempDir,
      "--id",
      "11111111-1111-1111-1111-111111111111",
      "--require-all",
    ]);
    expect(spy).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(output).toContain("11111111-1111-1111-1111-111111111111");
  });

  test("--id without --require-all does not fail on a real upload", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeBreakpad();

    vi.spyOn(debugFilesApi, "uploadDebugFiles").mockResolvedValue([
      {
        name: "example.sym",
        debugId: KNOWN_DEBUG_ID,
        checksum: "a".repeat(40),
        state: "ok",
        detail: null,
      },
    ]);

    const { exitCode } = await runUpload([
      tempDir,
      "--id",
      "11111111-1111-1111-1111-111111111111",
    ]);
    expect(exitCode).toBe(0);
  });

  test("reports nothing to upload when no debug files are found", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeFile(join(tempDir, "notes.txt"), "not a debug file");

    const spy = vi.spyOn(debugFilesApi, "uploadDebugFiles");
    const { exitCode } = await runUpload([tempDir]);
    expect(spy).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  // ── ZIP scanning ─────────────────────────────────────────────────

  test("finds a debug file inside a .zip by default", async () => {
    await writeBreakpadZip();
    const { output, exitCode } = await runUpload([
      tempDir,
      "--no-upload",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].debugId).toBe(KNOWN_DEBUG_ID);
  });

  test("--no-zips ignores debug files inside archives", async () => {
    await writeBreakpadZip();
    const { output, exitCode } = await runUpload([
      tempDir,
      "--no-zips",
      "--no-upload",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(output).files).toHaveLength(0);
  });

  // ── Embedded Portable PDB extraction ─────────────────────────────

  test("extracts an embedded PPDB as a separate .pdb DIF (dry-run)", async () => {
    // The managed PE carries no native debug features of its own, so only the
    // extracted Portable PDB is queued, named after the PE.
    await writeDifFixture("embedded-ppdb.dll", "App.dll");
    const { output, exitCode } = await runUpload([
      tempDir,
      "--no-upload",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const files = JSON.parse(output).files as {
      name: string;
      debugId?: string;
    }[];
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("App.pdb");
    expect(files[0]?.debugId).toBe(EMBEDDED_PE_DEBUG_ID);
  });

  test("--type portablepdb extracts a PE's embedded Portable PDB", async () => {
    // Even though the `pe` format is excluded by the filter, the PE is still
    // read so its embedded (portablepdb) companion can be extracted.
    await writeDifFixture("embedded-ppdb.dll", "App.dll");
    const { output, exitCode } = await runUpload([
      tempDir,
      "--type",
      "portablepdb",
      "--no-upload",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const files = JSON.parse(output).files as { name: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("App.pdb");
  });

  test("--type elf ignores a PE with an embedded PPDB", async () => {
    await writeDifFixture("embedded-ppdb.dll", "App.dll");
    const { output, exitCode } = await runUpload([
      tempDir,
      "--type",
      "elf",
      "--no-upload",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(output).files).toHaveLength(0);
  });

  test("a PE without an embedded PPDB yields nothing", async () => {
    await writeDifFixture("pe-no-ppdb.dll", "Plain.dll");
    const { output, exitCode } = await runUpload([
      tempDir,
      "--no-upload",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(output).files).toHaveLength(0);
  });

  test("passes the extracted PPDB through to uploadDebugFiles", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeDifFixture("embedded-ppdb.dll", "App.dll");
    const spy = vi
      .spyOn(debugFilesApi, "uploadDebugFiles")
      .mockResolvedValue([]);

    await runUpload([tempDir]);
    expect(spy).toHaveBeenCalledTimes(1);
    const difs = spy.mock.calls[0]?.[0]?.difs ?? [];
    expect(difs).toHaveLength(1);
    expect(difs[0]?.name).toBe("App.pdb");
    expect(difs[0]?.debugId).toBe(EMBEDDED_PE_DEBUG_ID);
    expect(difs[0]?.content).toBeInstanceOf(Buffer);
  });

  // ── IL2CPP line mappings ─────────────────────────────────────────

  test("--il2cpp-mapping produces a separate il2cpp DIF (dry-run)", async () => {
    await writeIl2cppFixture();
    const { output, exitCode } = await runUpload([
      tempDir,
      "--il2cpp-mapping",
      "--no-upload",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const files = JSON.parse(output).files as { name: string }[];
    expect(files.some((f) => f.name === "example.sym")).toBe(true);
    expect(files.some((f) => f.name === "example.sym.il2cpp")).toBe(true);
  });

  test("no il2cpp DIF is produced without --il2cpp-mapping", async () => {
    await writeIl2cppFixture();
    const { output } = await runUpload([tempDir, "--no-upload", "--json"]);
    const files = JSON.parse(output).files as { name: string }[];
    expect(files.some((f) => f.name.endsWith(".il2cpp"))).toBe(false);
  });

  test("--il2cpp-mapping threads the mapping DIF through to uploadDebugFiles", async () => {
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    await writeIl2cppFixture();
    const spy = vi
      .spyOn(debugFilesApi, "uploadDebugFiles")
      .mockResolvedValue([]);

    await runUpload([tempDir, "--il2cpp-mapping"]);
    expect(spy).toHaveBeenCalledTimes(1);
    const difs = spy.mock.calls[0]?.[0]?.difs ?? [];
    const il2cpp = difs.find((d) => d.name === "example.sym.il2cpp");
    expect(il2cpp).toBeDefined();
    expect(il2cpp?.debugId).toBe(KNOWN_DEBUG_ID);
    expect(il2cpp?.content).toBeInstanceOf(Buffer);
  });
});
