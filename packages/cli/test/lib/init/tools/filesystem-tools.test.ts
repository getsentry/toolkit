import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as dsnIndex from "../../../../src/lib/dsn/index.js";
import { executeTool } from "../../../../src/lib/init/tools/registry.js";
import type {
  ResolvedInitContext,
  ToolPayload,
} from "../../../../src/lib/init/types.js";
import { precomputeDirListing } from "../../../../src/lib/init/workflow-inputs.js";

function makeContext(directory: string): ResolvedInitContext {
  return {
    directory,
    yes: true,
    dryRun: false,
    org: "acme",
    team: "platform",
    authToken: "sntrys_test_token_123",
  };
}

let testDir: string;
let detectDsnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join("/tmp", "init-tools-"));
  detectDsnSpy = vi.spyOn(dsnIndex, "detectDsn").mockResolvedValue(null);
});

afterEach(() => {
  detectDsnSpy.mockRestore();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe("filesystem tools", () => {
  test("rejects tool execution when cwd escapes the project directory", async () => {
    const payload = {
      type: "tool",
      operation: "list-dir",
      cwd: "/",
      params: { path: "." },
    } as ToolPayload;

    const result = await executeTool(payload, makeContext(testDir));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside project directory");
  });

  test("rejects an external cwd symlink for every filesystem and shell tool", async () => {
    const outsideDir = fs.mkdtempSync(
      path.join(path.dirname(testDir), "init-tools-outside-")
    );
    const escapedCwd = path.join(testDir, "escape");
    fs.writeFileSync(path.join(outsideDir, "sentinel.txt"), "OUTSIDE\n");
    fs.symlinkSync(outsideDir, escapedCwd, "dir");
    const payloads: ToolPayload[] = [
      {
        type: "tool",
        operation: "list-dir",
        cwd: escapedCwd,
        params: { path: "." },
      },
      {
        type: "tool",
        operation: "read-files",
        cwd: escapedCwd,
        params: { paths: ["sentinel.txt"], resultVersion: 2 },
      },
      {
        type: "tool",
        operation: "file-exists-batch",
        cwd: escapedCwd,
        params: { paths: ["sentinel.txt"] },
      },
      {
        type: "tool",
        operation: "grep",
        cwd: escapedCwd,
        params: { searches: [{ pattern: "OUTSIDE" }] },
      },
      {
        type: "tool",
        operation: "glob",
        cwd: escapedCwd,
        params: { patterns: ["**/*"] },
      },
      {
        type: "tool",
        operation: "run-commands",
        cwd: escapedCwd,
        params: { commands: ["node --version"] },
      },
      {
        type: "tool",
        operation: "apply-patchset",
        cwd: escapedCwd,
        params: {
          patches: [
            {
              action: "create",
              path: "created-by-tool.txt",
              patch: "created outside the project\n",
            },
          ],
        },
      },
    ];

    try {
      for (const payload of payloads) {
        const result = await executeTool(payload, makeContext(testDir));
        expect(result.ok, payload.operation).toBe(false);
        expect(result.error, payload.operation).toContain(
          "outside project directory"
        );
      }
      expect(fs.existsSync(path.join(outsideDir, "created-by-tool.txt"))).toBe(
        false
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("allows a cwd symlink that resolves inside the selected project", async () => {
    fs.mkdirSync(path.join(testDir, "real", "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, "real", "nested", "inside.txt"),
      "inside\n"
    );
    fs.symlinkSync(
      path.join(testDir, "real"),
      path.join(testDir, "alias"),
      "dir"
    );

    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: path.join(testDir, "alias"),
        params: { paths: ["nested/inside.txt"], resultVersion: 2 },
      },
      makeContext(testDir)
    );

    expect(result.data).toEqual({
      files: {
        "nested/inside.txt": {
          content: "inside\n",
          status: "ok",
          truncated: false,
        },
      },
      version: 2,
    });
  });

  test("rejects sibling-prefix and missing cwd values", async () => {
    const siblingDir = `${testDir}-sibling`;
    fs.mkdirSync(siblingDir);
    try {
      for (const cwd of [siblingDir, path.join(testDir, "missing")]) {
        const result = await executeTool(
          {
            type: "tool",
            operation: "list-dir",
            cwd,
            params: { path: "." },
          },
          makeContext(testDir)
        );
        expect(result.ok, cwd).toBe(false);
        expect(result.error, cwd).toContain("outside project directory");
      }
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  test("lists and precomputes directory contents", async () => {
    fs.writeFileSync(path.join(testDir, "index.ts"), "export {};\n");
    fs.mkdirSync(path.join(testDir, "src"));
    fs.writeFileSync(
      path.join(testDir, "src", "app.ts"),
      "console.log('x');\n"
    );

    const result = await executeTool(
      {
        type: "tool",
        operation: "list-dir",
        cwd: testDir,
        params: { path: ".", recursive: true, maxDepth: 3 },
      },
      makeContext(testDir)
    );
    const entries = (result.data as { entries: Array<{ path: string }> })
      .entries;
    const precomputed = await precomputeDirListing(testDir);

    expect(result.ok).toBe(true);
    expect(entries.map((entry) => entry.path)).toContain("src/app.ts");
    expect(entries.find((entry) => entry.path === "src/app.ts")).toMatchObject({
      size: 18,
      type: "file",
    });
    expect(precomputed.map((entry) => entry.path)).toContain("src/app.ts");
  });

  test("reports when a bounded recursive listing is incomplete", async () => {
    fs.mkdirSync(path.join(testDir, "nested", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "nested", "deeper", "app.ts"), "x");
    fs.writeFileSync(path.join(testDir, "root.ts"), "x");

    const byDepth = await executeTool(
      {
        type: "tool",
        operation: "list-dir",
        cwd: testDir,
        params: { path: ".", recursive: true, maxDepth: 0, maxEntries: 100 },
      },
      makeContext(testDir)
    );
    const byEntries = await executeTool(
      {
        type: "tool",
        operation: "list-dir",
        cwd: testDir,
        params: { path: ".", recursive: true, maxDepth: 10, maxEntries: 1 },
      },
      makeContext(testDir)
    );

    expect(byDepth.data).toMatchObject({ truncated: true });
    expect(byEntries.data).toMatchObject({ truncated: true });
    expect((byEntries.data as { entries: unknown[] }).entries).toHaveLength(1);
  });

  test("reports an unreadable directory as an incomplete listing", async () => {
    const readdirSpy = vi
      .spyOn(fs.promises, "readdir")
      .mockRejectedValueOnce(new Error("permission denied"));

    try {
      const result = await executeTool(
        {
          type: "tool",
          operation: "list-dir",
          cwd: testDir,
          params: { path: ".", recursive: true },
        },
        makeContext(testDir)
      );

      expect(result).toMatchObject({
        data: { entries: [], truncated: true },
        ok: true,
      });
    } finally {
      readdirSpy.mockRestore();
    }
  });

  test.runIf(process.platform !== "win32")(
    "lists special files without opening them or attaching a size",
    async () => {
      const fifoPath = path.join(testDir, "stream.pipe");
      execFileSync("mkfifo", [fifoPath]);
      fs.writeFileSync(path.join(testDir, "regular.ts"), "export {};\n");
      const openSpy = vi.spyOn(fs, "openSync");
      const readSpy = vi.spyOn(fs, "readSync");

      try {
        const result = await executeTool(
          {
            type: "tool",
            operation: "list-dir",
            cwd: testDir,
            params: { path: "." },
          },
          makeContext(testDir)
        );
        const entry = (
          result.data as { entries: Record<string, unknown>[] }
        ).entries.find(({ path: entryPath }) => entryPath === "stream.pipe");
        const regular = (
          result.data as { entries: Record<string, unknown>[] }
        ).entries.find(({ path: entryPath }) => entryPath === "regular.ts");

        expect(entry).toEqual({
          name: "stream.pipe",
          path: "stream.pipe",
          type: "file",
        });
        expect(regular).toMatchObject({ size: 11, type: "file" });
        expect(openSpy).not.toHaveBeenCalled();
        expect(readSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
        readSpy.mockRestore();
      }
    }
  );

  test("reads files and checks existence in batches", async () => {
    fs.writeFileSync(path.join(testDir, "exists.txt"), "hello");

    const readResult = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          paths: ["exists.txt", "missing.txt"],
          resultVersion: 2,
        },
      },
      makeContext(testDir)
    );
    const existsResult = await executeTool(
      {
        type: "tool",
        operation: "file-exists-batch",
        cwd: testDir,
        params: { paths: ["exists.txt", "missing.txt"] },
      },
      makeContext(testDir)
    );

    expect((readResult.data as any).files["exists.txt"]).toEqual({
      content: "hello",
      status: "ok",
      truncated: false,
    });
    expect((readResult.data as any).files["missing.txt"]).toEqual({
      error: "not-found",
      status: "error",
    });
    expect((existsResult.data as any).exists["exists.txt"]).toBe(true);
    expect((existsResult.data as any).exists["missing.txt"]).toBe(false);
  });

  test("returns independent bounded V2 line ranges", async () => {
    const lines = Array.from(
      { length: 8 },
      (_, index) => `line-${index + 1}:${"x".repeat(19_990)}\n`
    );
    fs.writeFileSync(path.join(testDir, "large.txt"), lines.join(""));

    const first = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          paths: ["large.txt"],
          resultVersion: 2,
        },
      },
      makeContext(testDir)
    );
    const later = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          paths: ["large.txt"],
          resultVersion: 2,
          startLine: 5,
        },
      },
      makeContext(testDir)
    );

    expect(first.data).toEqual({
      files: {
        "large.txt": {
          content: lines.slice(0, 2).join(""),
          status: "ok",
          truncated: true,
        },
      },
      version: 2,
    });
    expect(later.data).toEqual({
      files: {
        "large.txt": {
          content: lines.slice(4, 6).join(""),
          status: "ok",
          truncated: true,
        },
      },
      version: 2,
    });
  });

  test("preserves exact line endings in V2 snapshots", async () => {
    const firstLine = `${"x".repeat(39_997)}\r\n`;
    fs.writeFileSync(
      path.join(testDir, "windows.txt"),
      `${firstLine}second\r\n`
    );

    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          paths: ["windows.txt"],
          resultVersion: 2,
        },
      },
      makeContext(testDir)
    );

    expect(result.data).toEqual({
      files: {
        "windows.txt": {
          content: firstLine,
          status: "ok",
          truncated: true,
        },
      },
      version: 2,
    });
  });

  test("finds a continuation and fills its window after short descriptor reads", async () => {
    const filePath = path.join(testDir, "short-reads.txt");
    const content = "first\nsecond\nthird\n";
    fs.writeFileSync(filePath, content);
    const actualHandle = await fs.promises.open(filePath, "r");
    const shortRead = vi.fn(
      (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null
      ) => actualHandle.read(buffer, offset, Math.min(length, 3), position)
    );
    const openSpy = vi.spyOn(fs.promises, "open").mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      read: shortRead,
      stat: () => actualHandle.stat(),
    } as unknown as fs.promises.FileHandle);

    try {
      const result = await executeTool(
        {
          type: "tool",
          operation: "read-files",
          cwd: testDir,
          params: {
            paths: ["short-reads.txt"],
            resultVersion: 2,
            startLine: 2,
          },
        },
        makeContext(testDir)
      );

      expect(result.data).toEqual({
        files: {
          "short-reads.txt": {
            content: "second\nthird\n",
            status: "ok",
            truncated: false,
          },
        },
        version: 2,
      });
      expect(shortRead.mock.calls.length).toBeGreaterThan(1);
    } finally {
      openSpy.mockRestore();
      await actualHandle.close();
    }
  });

  test("rejects malformed V2 read requests before local I/O", async () => {
    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: undefined,
      } as unknown as ToolPayload,
      makeContext(testDir)
    );

    expect(result).toEqual({
      error: "read-files params must be an object",
      ok: false,
    });
  });

  test("rejects read requests without the V2 result contract", async () => {
    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths: ["package.json"] },
      } as unknown as ToolPayload,
      makeContext(testDir)
    );

    expect(result).toEqual({
      error: "read-files requires resultVersion 2",
      ok: false,
    });
  });

  test("canonicalizes slash styles while preserving ordinary spaces", async () => {
    fs.mkdirSync(path.join(testDir, "dir with spaces", "nested dir"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(testDir, "posix"));
    fs.writeFileSync(
      path.join(testDir, "dir with spaces", "nested dir", "file name.ts"),
      "mixed separators\n"
    );
    fs.writeFileSync(path.join(testDir, "posix", "file.ts"), "posix path\n");

    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          paths: ["dir with spaces\\nested dir/file name.ts", "posix/file.ts"],
          resultVersion: 2,
        },
      },
      makeContext(testDir)
    );

    expect(result.data).toEqual({
      files: {
        "dir with spaces/nested dir/file name.ts": {
          content: "mixed separators\n",
          status: "ok",
          truncated: false,
        },
        "posix/file.ts": {
          content: "posix path\n",
          status: "ok",
          truncated: false,
        },
      },
      version: 2,
    });
  });

  test("rejects non-portable read paths before opening requested files", async () => {
    const invalidPaths = [
      "/etc/passwd",
      "\\etc\\passwd",
      "C:/repo/package.json",
      "C:\\repo\\package.json",
      "C:repo/package.json",
      "\\\\server\\share\\package.json",
      "//server/share/package.json",
      "../outside.txt",
      "apps/../../outside.txt",
      "./package.json",
      "apps/./package.json",
      "apps//package.json",
      "apps\\\\package.json",
      "apps/",
      "package\0.json",
      "package\n.json",
      "package\u007f.json",
      "folder /package.json",
      "package.json.",
      "CON",
      "con.txt",
      "apps/NUL.json",
      "COM1",
      "lpt9.log",
      "package.json:secret",
    ];
    const openSpy = vi.spyOn(fs.promises, "open");

    try {
      for (const filePath of invalidPaths) {
        const result = await executeTool(
          {
            type: "tool",
            operation: "read-files",
            cwd: testDir,
            params: { paths: [filePath], resultVersion: 2 },
          },
          makeContext(testDir)
        );

        expect(result, filePath).toEqual({
          error:
            "read-files paths must be portable filesystem-root-relative paths without aliases",
          ok: false,
        });
      }
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  test("rejects duplicate aliases after path normalization", async () => {
    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          paths: ["apps/web/package.json", "apps\\web\\package.json"],
          resultVersion: 2,
        },
      },
      makeContext(testDir)
    );

    expect(result).toEqual({
      error: "read-files paths must be unique after path normalization",
      ok: false,
    });
  });

  test("reads regular metadata files while preserving sandbox and text bounds", async () => {
    fs.writeFileSync(path.join(testDir, ".env.local"), "SECRET=value\n");
    fs.writeFileSync(
      path.join(testDir, ".netrc"),
      "machine example.test login user password secret\n"
    );
    fs.writeFileSync(path.join(testDir, ".pypirc"), "token=secret\n");
    fs.writeFileSync(
      path.join(testDir, ".npmrc"),
      "//registry/:_authToken=secret\n"
    );
    fs.writeFileSync(path.join(testDir, "binary.txt"), Buffer.from([0, 1, 2]));

    const environment = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths: [".env.local"], resultVersion: 2 },
      },
      makeContext(testDir)
    );
    const binary = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths: ["binary.txt"], resultVersion: 2 },
      },
      makeContext(testDir)
    );
    const packageMetadata = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths: [".pypirc"], resultVersion: 2 },
      },
      makeContext(testDir)
    );
    const netrc = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths: [".netrc"], resultVersion: 2 },
      },
      makeContext(testDir)
    );
    const npmConfig = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths: [".npmrc"], resultVersion: 2 },
      },
      makeContext(testDir)
    );
    expect(environment.data).toEqual({
      files: {
        ".env.local": {
          content: "SECRET=value\n",
          status: "ok",
          truncated: false,
        },
      },
      version: 2,
    });
    expect(packageMetadata.data).toEqual({
      files: {
        ".pypirc": {
          content: "token=secret\n",
          status: "ok",
          truncated: false,
        },
      },
      version: 2,
    });
    expect(netrc.data).toEqual({
      files: {
        ".netrc": {
          content: "machine example.test login user password secret\n",
          status: "ok",
          truncated: false,
        },
      },
      version: 2,
    });
    expect(npmConfig.data).toEqual({
      files: {
        ".npmrc": {
          content: "//registry/:_authToken=secret\n",
          status: "ok",
          truncated: false,
        },
      },
      version: 2,
    });
    expect(binary.data).toEqual({
      files: { "binary.txt": { error: "not-text", status: "error" } },
      version: 2,
    });
  });

  test("rejects aliases to sensitive files", async () => {
    fs.writeFileSync(
      path.join(testDir, ".netrc"),
      "machine example.test login user password secret\n"
    );
    fs.symlinkSync(".netrc", path.join(testDir, "credentials.txt"));
    fs.symlinkSync(".netrc", path.join(testDir, ".pypirc"));

    const alias = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths: ["credentials.txt"], resultVersion: 2 },
      },
      makeContext(testDir)
    );
    const sensitiveNameAlias = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths: [".pypirc"], resultVersion: 2 },
      },
      makeContext(testDir)
    );

    expect(alias.data).toEqual({
      files: {
        "credentials.txt": { error: "unreadable", status: "error" },
      },
      version: 2,
    });
    expect(sensitiveNameAlias.data).toEqual({
      files: { ".pypirc": { error: "unreadable", status: "error" } },
      version: 2,
    });
  });

  test("rejects regular-file symlinks that escape the project root", async () => {
    const outsideDir = fs.mkdtempSync(path.join("/tmp", "init-tools-outside-"));
    const sentinel = "OUTSIDE_PROJECT_SENTINEL";
    try {
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, sentinel);
      fs.symlinkSync(outsideFile, path.join(testDir, "inside.txt"));

      const result = await executeTool(
        {
          type: "tool",
          operation: "read-files",
          cwd: testDir,
          params: { paths: ["inside.txt"], resultVersion: 2 },
        },
        makeContext(testDir)
      );

      expect(result.data).toEqual({
        files: { "inside.txt": { error: "unreadable", status: "error" } },
        version: 2,
      });
      expect(JSON.stringify(result)).not.toContain(sentinel);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("finds later lines without exposing a cursor protocol", async () => {
    fs.writeFileSync(
      path.join(testDir, "deep.txt"),
      `${"x".repeat(270_000)}\ntarget\n`
    );

    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          paths: ["deep.txt"],
          resultVersion: 2,
          startLine: 2,
        },
      },
      makeContext(testDir)
    );

    expect(result.data).toEqual({
      files: {
        "deep.txt": {
          content: "target\n",
          status: "ok",
          truncated: false,
        },
      },
      version: 2,
    });
  });

  test("allows 20 normal V2 paths, bounds their content, and rejects 21", async () => {
    const paths = Array.from({ length: 20 }, (_, index) => `file-${index}.txt`);
    for (const filePath of paths) {
      fs.writeFileSync(path.join(testDir, filePath), "x\n".repeat(5000));
    }

    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths, resultVersion: 2 },
      },
      makeContext(testDir)
    );
    const overLimit = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          paths: [...paths, "file-20.txt"],
          resultVersion: 2,
        },
      },
      makeContext(testDir)
    );
    const files = (
      result.data as {
        files: Record<string, { content: string; truncated: boolean }>;
      }
    ).files;

    expect(result.ok).toBe(true);
    expect(
      Object.values(files).reduce(
        (total, file) => total + Buffer.byteLength(file.content),
        0
      )
    ).toBe(40_000);
    expect(Object.values(files).every((file) => file.truncated)).toBe(true);
    expect(overLimit).toEqual({
      error: "read-files requires between 1 and 20 paths",
      ok: false,
    });
  });

  test("rejects a continuation request with more than one path", async () => {
    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          paths: ["first.txt", "second.txt"],
          resultVersion: 2,
          startLine: 2,
        },
      },
      makeContext(testDir)
    );

    expect(result).toEqual({
      error: "read-files range reads require exactly one path",
      ok: false,
    });
  });

  test("does not impose a separate line limit on V2 reads", async () => {
    const content = "x\n".repeat(1500);
    fs.writeFileSync(path.join(testDir, "many-lines.txt"), content);

    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: { paths: ["many-lines.txt"], resultVersion: 2 },
      },
      makeContext(testDir)
    );

    expect(result.data).toEqual({
      files: {
        "many-lines.txt": { content, status: "ok", truncated: false },
      },
      version: 2,
    });
  });

  test("rejects byte-budget knobs instead of enabling another profile", async () => {
    const result = await executeTool(
      {
        type: "tool",
        operation: "read-files",
        cwd: testDir,
        params: {
          maxBytes: 262_144,
          paths: ["large.txt"],
          resultVersion: 2,
        },
      } as ToolPayload,
      makeContext(testDir)
    );

    expect(result).toEqual({
      error: "read-files params include unsupported fields",
      ok: false,
    });
  });

  test("streams a continuation beyond 4 MiB with bounded read buffers", async () => {
    const filePath = path.join(testDir, "deep-continuation.txt");
    const splitUtf8Prefix = `${"x".repeat(5 * 1024 * 1024 - 1)}é\n`;
    fs.writeFileSync(filePath, `${splitUtf8Prefix}target\n`);
    const actualHandle = await fs.promises.open(filePath, "r");
    const requestedLengths: number[] = [];
    const streamedRead = vi.fn(
      (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null
      ) => {
        requestedLengths.push(length);
        return actualHandle.read(buffer, offset, length, position);
      }
    );
    const openSpy = vi.spyOn(fs.promises, "open").mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      read: streamedRead,
      stat: () => actualHandle.stat(),
    } as unknown as fs.promises.FileHandle);

    try {
      const result = await executeTool(
        {
          type: "tool",
          operation: "read-files",
          cwd: testDir,
          params: {
            paths: ["deep-continuation.txt"],
            resultVersion: 2,
            startLine: 2,
          },
        },
        makeContext(testDir)
      );

      expect(result.data).toEqual({
        files: {
          "deep-continuation.txt": {
            content: "target\n",
            status: "ok",
            truncated: false,
          },
        },
        version: 2,
      });
      expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(64 * 1024);
      expect(streamedRead.mock.calls.length).toBeGreaterThan(64);
    } finally {
      openSpy.mockRestore();
      await actualHandle.close();
    }
  });

  test("stops reading an enormous first line at the output budget", async () => {
    const filePath = path.join(testDir, "enormous-line.txt");
    fs.writeFileSync(filePath, `${"x".repeat(8 * 1024 * 1024)}\n`);
    const actualHandle = await fs.promises.open(filePath, "r");
    let totalBytesRead = 0;
    const boundedRead = vi.fn(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null
      ) => {
        const result = await actualHandle.read(
          buffer,
          offset,
          length,
          position
        );
        totalBytesRead += result.bytesRead;
        return result;
      }
    );
    const openSpy = vi.spyOn(fs.promises, "open").mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      read: boundedRead,
      stat: () => actualHandle.stat(),
    } as unknown as fs.promises.FileHandle);

    try {
      const result = await executeTool(
        {
          type: "tool",
          operation: "read-files",
          cwd: testDir,
          params: {
            paths: ["enormous-line.txt"],
            resultVersion: 2,
          },
        },
        makeContext(testDir)
      );

      expect(result.data).toEqual({
        files: {
          "enormous-line.txt": { error: "line-too-long", status: "error" },
        },
        version: 2,
      });
      expect(totalBytesRead).toBe(40_000);
    } finally {
      openSpy.mockRestore();
      await actualHandle.close();
    }
  });

  test("rejects invalid UTF-8 and incomplete multibyte lines", async () => {
    fs.writeFileSync(
      path.join(testDir, "invalid-utf8.txt"),
      Buffer.from([0x61, 0x62, 0x63, 0xff])
    );
    fs.writeFileSync(
      path.join(testDir, "multibyte.txt"),
      `${"é".repeat(20_001)}\n`
    );

    const read = (filePath: string) =>
      executeTool(
        {
          type: "tool",
          operation: "read-files",
          cwd: testDir,
          params: {
            paths: [filePath],
            resultVersion: 2,
          },
        },
        makeContext(testDir)
      );

    expect((await read("invalid-utf8.txt")).data).toEqual({
      files: {
        "invalid-utf8.txt": { error: "not-text", status: "error" },
      },
      version: 2,
    });
    expect((await read("multibyte.txt")).data).toEqual({
      files: {
        "multibyte.txt": { error: "line-too-long", status: "error" },
      },
      version: 2,
    });
  });

  test("preserves not-file when descriptor cleanup fails", async () => {
    const close = vi.fn().mockRejectedValue(new Error("close failed"));
    const open = vi.spyOn(fs.promises, "open").mockResolvedValue({
      close,
      stat: vi.fn().mockResolvedValue({ isFile: () => false }),
    } as unknown as fs.promises.FileHandle);

    try {
      const result = await executeTool(
        {
          type: "tool",
          operation: "read-files",
          cwd: testDir,
          params: { paths: ["directory"], resultVersion: 2 },
        },
        makeContext(testDir)
      );

      expect(result.data).toEqual({
        files: { directory: { error: "not-file", status: "error" } },
        version: 2,
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      open.mockRestore();
    }
  });

  test("applies patchsets and injects auth tokens into env files", async () => {
    const result = await executeTool(
      {
        type: "tool",
        operation: "apply-patchset",
        cwd: testDir,
        params: {
          patches: [
            {
              path: ".env.sentry-build-plugin",
              action: "create",
              patch: "SENTRY_AUTH_TOKEN=\n",
            },
          ],
        },
      },
      makeContext(testDir)
    );

    expect(result.ok).toBe(true);
    expect(
      fs.readFileSync(path.join(testDir, ".env.sentry-build-plugin"), "utf-8")
    ).toContain("sntrys_test_token_123");
  });

  test("rejects unsafe apply-patchset paths before writing", async () => {
    const unsafePaths: unknown[] = [
      null,
      "../../outside.txt",
      "/tmp/outside.txt",
      "C:/repo/package.json",
      "C:\\repo\\package.json",
      "apps/../package.json",
      "./package.json",
      "apps//package.json",
    ];

    for (const unsafePath of unsafePaths) {
      const result = await executeTool(
        {
          type: "tool",
          operation: "apply-patchset",
          cwd: testDir,
          params: {
            patches: [
              {
                path: unsafePath as never,
                action: "create",
                patch: "should not be written\n",
              },
            ],
          },
        },
        makeContext(testDir)
      );

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(
        /Invalid (?:file change path|file changes request)/
      );
    }
  });

  test("applies patchsets to nested project-relative files", async () => {
    fs.mkdirSync(path.join(testDir, "Cary.ConversionFunnels.API"));
    fs.writeFileSync(
      path.join(
        testDir,
        "Cary.ConversionFunnels.API",
        "Cary.ConversionFunnels.API.csproj"
      ),
      "<Project></Project>\n"
    );

    const result = await executeTool(
      {
        type: "tool",
        operation: "apply-patchset",
        cwd: testDir,
        params: {
          patches: [
            {
              path: "Directory.Packages.props",
              action: "create",
              patch: "<Project></Project>\n",
            },
            {
              path: "Cary.ConversionFunnels.API/Cary.ConversionFunnels.API.csproj",
              action: "modify",
              edits: [
                {
                  oldString: "<Project></Project>",
                  newString:
                    '<Project><ItemGroup><PackageReference Include="Sentry.AspNetCore" /></ItemGroup></Project>',
                },
              ],
            },
          ],
        },
      },
      makeContext(testDir)
    );

    expect(result.ok).toBe(true);
    expect(
      fs.readFileSync(path.join(testDir, "Directory.Packages.props"), "utf-8")
    ).toContain("<Project>");
    expect(
      fs.readFileSync(
        path.join(
          testDir,
          "Cary.ConversionFunnels.API",
          "Cary.ConversionFunnels.API.csproj"
        ),
        "utf-8"
      )
    ).toContain("Sentry.AspNetCore");
  });

  test("greps and globs files inside the project", async () => {
    fs.mkdirSync(path.join(testDir, "src"));
    fs.writeFileSync(
      path.join(testDir, "src", "app.ts"),
      "Sentry.captureException(error);\n"
    );

    const grepResult = await executeTool(
      {
        type: "tool",
        operation: "grep",
        cwd: testDir,
        params: { searches: [{ pattern: "captureException" }] },
      },
      makeContext(testDir)
    );
    const globResult = await executeTool(
      {
        type: "tool",
        operation: "glob",
        cwd: testDir,
        params: { patterns: ["**/*.ts"] },
      },
      makeContext(testDir)
    );

    expect((grepResult.data as any).results[0].matches[0].path).toBe(
      "src/app.ts"
    );
    expect((globResult.data as any).results[0].files).toContain("src/app.ts");
  });

  test("reports installed Sentry signals when a DSN is detected", async () => {
    detectDsnSpy.mockResolvedValue({
      publicKey: "abc",
      protocol: "https",
      host: "o1.ingest.sentry.io",
      projectId: "42",
      raw: "https://abc@o1.ingest.sentry.io/42",
      source: "env_file" as const,
      sourcePath: ".env",
    });

    const result = await executeTool(
      {
        type: "tool",
        operation: "detect-sentry",
        cwd: testDir,
        params: {},
      },
      makeContext(testDir)
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        status: "installed",
        dsn: "https://abc@o1.ingest.sentry.io/42",
      })
    );
  });
});
