import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyPatchset } from "../../../../src/lib/init/tools/apply-patchset.js";
import { applyPreparedFileChanges } from "../../../../src/lib/init/tools/file-changes/apply.js";
import { prepareFileChanges } from "../../../../src/lib/init/tools/file-changes/prepare.js";

const AUTH_TOKEN = "sntrys_test_token_123";

function request(cwd: string, patches: Record<string, unknown>[]): unknown {
  return {
    cwd,
    operation: "apply-patchset",
    params: { patches },
    type: "tool",
  };
}

describe("apply file changes", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "init-file-changes-"));
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  test("prepares the entire batch before writing any file", async () => {
    const result = await applyPatchset(
      request(directory, [
        { action: "create", patch: "created\n", path: "created.txt" },
        {
          action: "modify",
          edits: [{ newString: "new", oldString: "old" }],
          path: "missing.txt",
        },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result).toMatchObject({
      data: {
        applied: [],
        failed: { code: "missing_file", path: "missing.txt" },
      },
      ok: false,
    });
    expect(() => readFileSync(path.join(directory, "created.txt"))).toThrow();
  });

  test("never overwrites an existing create target", async () => {
    const target = path.join(directory, "existing.txt");
    writeFileSync(target, "original\n");

    const result = await applyPatchset(
      request(directory, [
        { action: "create", patch: "replacement\n", path: "existing.txt" },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result).toMatchObject({
      data: { failed: { code: "already_exists" } },
      ok: false,
    });
    expect(readFileSync(target, "utf-8")).toBe("original\n");
  });

  test("dry-run performs real preparation without writing", async () => {
    const valid = await applyPatchset(
      request(directory, [
        { action: "create", patch: "preview\n", path: "preview.txt" },
      ]),
      { authToken: undefined, dryRun: true }
    );
    const invalid = await applyPatchset(
      request(directory, [
        {
          action: "modify",
          edits: [{ newString: "new", oldString: "old" }],
          path: "missing.txt",
        },
      ]),
      { authToken: undefined, dryRun: true }
    );

    expect(valid).toMatchObject({ data: { dryRun: true }, ok: true });
    expect(invalid).toMatchObject({
      data: { failed: { code: "missing_file" } },
      ok: false,
    });
    expect(() => readFileSync(path.join(directory, "preview.txt"))).toThrow();
  });

  test("rejects fuzzy anchor matches instead of replacing different code", async () => {
    const target = path.join(directory, "setup.ts");
    const original = [
      "function setup() {",
      "  const actual = initializeProduction();",
      "  return actual;",
      "}",
    ].join("\n");
    writeFileSync(target, original);

    const result = await applyPatchset(
      request(directory, [
        {
          action: "modify",
          edits: [
            {
              newString: "replacement();",
              oldString: [
                "function setup() {",
                "  const guessed = initializeTest();",
                "  return guessed;",
                "}",
              ].join("\n"),
            },
          ],
          path: "setup.ts",
        },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result).toMatchObject({
      data: { failed: { code: "edit_not_found" } },
      ok: false,
    });
    expect(readFileSync(target, "utf-8")).toBe(original);
  });

  test("preserves CRLF and a UTF-8 BOM", async () => {
    const target = path.join(directory, "config.ts");
    writeFileSync(target, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

    const result = await applyPatchset(
      request(directory, [
        {
          action: "modify",
          edits: [{ newString: "changed\n", oldString: "second\n" }],
          path: "config.ts",
        },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(
      "\uFEFFfirst\r\nchanged\r\nthird\r\n"
    );
  });

  test("rejects a stale modify prepared from older content", async () => {
    const target = path.join(directory, "config.ts");
    writeFileSync(target, "const value = 1;\n");
    const prepared = await prepareFileChanges(directory, [
      {
        action: "modify",
        edits: [
          { newString: "const value = 2;", oldString: "const value = 1;" },
        ],
        path: "config.ts",
      },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    writeFileSync(target, "const value = 3;\n");

    const result = await applyPreparedFileChanges(prepared.changes, false);

    expect(result).toMatchObject({
      data: { failed: { code: "stale_content" } },
      ok: false,
    });
    expect(readFileSync(target, "utf-8")).toBe("const value = 3;\n");
  });

  test("rejects a same-content file replaced after preparation", async () => {
    const target = path.join(directory, "config.ts");
    const original = path.join(directory, "config.original.ts");
    writeFileSync(target, "const value = 1;\n");
    const prepared = await prepareFileChanges(directory, [
      {
        action: "modify",
        edits: [
          { newString: "const value = 2;", oldString: "const value = 1;" },
        ],
        path: "config.ts",
      },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    renameSync(target, original);
    writeFileSync(target, "const value = 1;\n");

    const result = await applyPreparedFileChanges(prepared.changes, false);

    expect(result).toMatchObject({
      data: { failed: { code: "stale_content" } },
      ok: false,
    });
    expect(readFileSync(target, "utf-8")).toBe("const value = 1;\n");
    expect(readFileSync(original, "utf-8")).toBe("const value = 1;\n");
  });

  test("reports unavoidable write-time partial application", async () => {
    const prepared = await prepareFileChanges(directory, [
      { action: "create", content: "first\n", path: "first.txt" },
      {
        action: "create",
        content: "second\n",
        path: "blocked/second.txt",
      },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    writeFileSync(path.join(directory, "blocked"), "not a directory\n");

    const result = await applyPreparedFileChanges(prepared.changes, false);

    expect(result).toMatchObject({
      data: {
        applied: [{ action: "create", path: "first.txt" }],
        failed: { code: "stale_content", path: "blocked/second.txt" },
      },
      ok: false,
    });
    expect(readFileSync(path.join(directory, "first.txt"), "utf-8")).toBe(
      "first\n"
    );
  });

  test.skipIf(process.platform === "win32")(
    "maps an I/O failure after an applied change to write_failed",
    async () => {
      const blockedDirectory = path.join(directory, "blocked");
      mkdirSync(blockedDirectory);
      const prepared = await prepareFileChanges(directory, [
        { action: "create", content: "first\n", path: "first.txt" },
        {
          action: "create",
          content: "second\n",
          path: "blocked/second.txt",
        },
      ]);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        return;
      }
      chmodSync(blockedDirectory, 0o500);

      const result = await applyPreparedFileChanges(
        prepared.changes,
        false
      ).finally(() => chmodSync(blockedDirectory, 0o700));

      expect(result).toMatchObject({
        data: {
          applied: [{ action: "create", path: "first.txt" }],
          failed: { code: "write_failed", path: "blocked/second.txt" },
        },
        ok: false,
      });
      expect(existsSync(path.join(blockedDirectory, "second.txt"))).toBe(false);
    }
  );

  test("injects auth locally without returning it in tool data", async () => {
    const result = await applyPatchset(
      request(directory, [
        {
          action: "create",
          patch: "SENTRY_AUTH_TOKEN=\n",
          path: ".env.sentry-build-plugin",
        },
      ]),
      { authToken: AUTH_TOKEN, dryRun: false }
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(AUTH_TOKEN);
    expect(
      readFileSync(path.join(directory, ".env.sentry-build-plugin"), "utf-8")
    ).toContain(AUTH_TOKEN);
  });

  test("rejects malformed and duplicate file-change requests", async () => {
    const malformed = await applyPatchset(
      request(directory, [{ action: "modify", edits: [], path: "config.ts" }]),
      { authToken: undefined, dryRun: false }
    );
    const duplicate = await applyPatchset(
      request(directory, [
        { action: "create", patch: "first", path: "same.txt" },
        { action: "create", patch: "second", path: "same.txt" },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(malformed).toMatchObject({ ok: false });
    expect(malformed.error).toContain("edits must not be empty");
    expect(duplicate).toMatchObject({
      data: { failed: { code: "duplicate_target" } },
      ok: false,
    });
  });

  test("preserves an existing file mode on modify", async () => {
    const target = path.join(directory, "script.sh");
    writeFileSync(target, "echo old\n");
    chmodSync(target, 0o755);

    const result = await applyPatchset(
      request(directory, [
        {
          action: "modify",
          edits: [{ newString: "echo new", oldString: "echo old" }],
          path: "script.sh",
        },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("echo new\n");
    expect(statSync(target).mode % 0o1000).toBe(0o755);
  });

  test("creates nested directories only during the apply phase", async () => {
    const prepared = await prepareFileChanges(directory, [
      { action: "create", content: "content\n", path: "nested/file.txt" },
    ]);
    expect(prepared.ok).toBe(true);
    expect(existsSync(path.join(directory, "nested"))).toBe(false);
    if (!prepared.ok) {
      return;
    }

    const result = await applyPreparedFileChanges(prepared.changes, false);

    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(directory, "nested/file.txt"), "utf-8")).toBe(
      "content\n"
    );
  });

  test("keeps delete idempotent but refuses to delete a new target", async () => {
    const prepared = await prepareFileChanges(directory, [
      { action: "delete", path: "missing.txt" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    writeFileSync(path.join(directory, "missing.txt"), "appeared\n");

    const result = await applyPreparedFileChanges(prepared.changes, false);

    expect(result).toMatchObject({
      data: { failed: { code: "stale_content" } },
      ok: false,
    });
    expect(readFileSync(path.join(directory, "missing.txt"), "utf-8")).toBe(
      "appeared\n"
    );
  });

  test("rejects ambiguous exact edits", async () => {
    const target = path.join(directory, "duplicate.txt");
    writeFileSync(target, "same\nsame\n");

    const result = await applyPatchset(
      request(directory, [
        {
          action: "modify",
          edits: [{ newString: "changed", oldString: "same" }],
          path: "duplicate.txt",
        },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result).toMatchObject({
      data: { failed: { code: "edit_ambiguous" } },
      ok: false,
    });
    expect(readFileSync(target, "utf-8")).toBe("same\nsame\n");
  });

  test("rejects overlapping and invalid no-op matches", async () => {
    writeFileSync(path.join(directory, "overlap.txt"), "aaa");

    const overlapping = await applyPatchset(
      request(directory, [
        {
          action: "modify",
          edits: [{ newString: "b", oldString: "aa" }],
          path: "overlap.txt",
        },
      ]),
      { authToken: undefined, dryRun: false }
    );
    const absentNoOp = await applyPatchset(
      request(directory, [
        {
          action: "modify",
          edits: [{ newString: "missing", oldString: "missing" }],
          path: "overlap.txt",
        },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(overlapping).toMatchObject({
      data: { failed: { code: "edit_ambiguous" } },
      ok: false,
    });
    expect(absentNoOp).toMatchObject({
      data: { failed: { code: "edit_not_found" } },
      ok: false,
    });
    expect(readFileSync(path.join(directory, "overlap.txt"), "utf-8")).toBe(
      "aaa"
    );
  });

  test("rejects ancestor and descendant targets before writing", async () => {
    const result = await applyPatchset(
      request(directory, [
        { action: "create", patch: "file", path: "nested" },
        { action: "create", patch: "child", path: "nested/child.txt" },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result).toMatchObject({
      data: { applied: [], failed: { code: "path_conflict" } },
      ok: false,
    });
    expect(existsSync(path.join(directory, "nested"))).toBe(false);
  });

  test("composes repeated modifies in their original order", async () => {
    const target = path.join(directory, "config.ts");
    writeFileSync(target, "const value = 1;\n");

    const result = await applyPatchset(
      request(directory, [
        {
          action: "modify",
          edits: [
            { newString: "const value = 2;", oldString: "const value = 1;" },
          ],
          path: "config.ts",
        },
        {
          action: "modify",
          edits: [
            { newString: "const value = 3;", oldString: "const value = 2;" },
          ],
          path: "config.ts",
        },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("const value = 3;\n");
  });

  test("revalidates path containment immediately before writing", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "init-file-outside-"));
    const prepared = await prepareFileChanges(directory, [
      { action: "create", content: "blocked\n", path: "nested/file.txt" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    symlinkSync(outside, path.join(directory, "nested"));

    const result = await applyPreparedFileChanges(prepared.changes, false);

    expect(result).toMatchObject({
      data: { failed: { code: "stale_content" } },
      ok: false,
    });
    expect(existsSync(path.join(outside, "file.txt"))).toBe(false);
    rmSync(outside, { force: true, recursive: true });
  });

  test("rejects a project root symlink retargeted after preparation", async () => {
    const originalRoot = path.join(directory, "original");
    const outside = mkdtempSync(path.join(tmpdir(), "init-root-outside-"));
    const rootLink = path.join(directory, "project");
    mkdirSync(originalRoot);
    symlinkSync(originalRoot, rootLink);
    const prepared = await prepareFileChanges(rootLink, [
      { action: "create", content: "blocked\n", path: "file.txt" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    rmSync(rootLink);
    symlinkSync(outside, rootLink);

    const result = await applyPreparedFileChanges(prepared.changes, false);

    expect(result).toMatchObject({
      data: { failed: { code: "stale_content" } },
      ok: false,
    });
    expect(existsSync(path.join(outside, "file.txt"))).toBe(false);
    rmSync(outside, { force: true, recursive: true });
  });

  test("rejects filesystem aliases that target the same file", async () => {
    const realDirectory = path.join(directory, "real");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, path.join(directory, "alias"));

    const result = await applyPatchset(
      request(directory, [
        { action: "create", patch: "first\n", path: "real/file.txt" },
        { action: "create", patch: "second\n", path: "alias/file.txt" },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result).toMatchObject({
      data: { applied: [], failed: { code: "path_conflict" } },
      ok: false,
    });
    expect(existsSync(path.join(realDirectory, "file.txt"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "rejects hard-link aliases before writing",
    async () => {
      const first = path.join(directory, "first.txt");
      const second = path.join(directory, "second.txt");
      writeFileSync(first, "old\n");
      linkSync(first, second);

      const result = await applyPatchset(
        request(directory, [
          {
            action: "modify",
            edits: [{ newString: "first", oldString: "old" }],
            path: "first.txt",
          },
          {
            action: "modify",
            edits: [{ newString: "second", oldString: "old" }],
            path: "second.txt",
          },
        ]),
        { authToken: undefined, dryRun: false }
      );

      expect(result).toMatchObject({
        data: { applied: [], failed: { code: "path_conflict" } },
        ok: false,
      });
      expect(readFileSync(first, "utf-8")).toBe("old\n");
      expect(readFileSync(second, "utf-8")).toBe("old\n");
    }
  );

  test("uses exclusive create at apply time", async () => {
    const prepared = await prepareFileChanges(directory, [
      { action: "create", content: "new\n", path: "created-later.txt" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    const target = path.join(directory, "created-later.txt");
    writeFileSync(target, "external\n");

    const result = await applyPreparedFileChanges(prepared.changes, false);

    expect(result).toMatchObject({
      data: { failed: { code: "stale_content" } },
      ok: false,
    });
    expect(readFileSync(target, "utf-8")).toBe("external\n");
  });

  test("applies a successful create, modify, and delete batch", async () => {
    writeFileSync(path.join(directory, "modify.txt"), "old\n");
    writeFileSync(path.join(directory, "delete.txt"), "remove\n");

    const result = await applyPatchset(
      request(directory, [
        { action: "create", patch: "created\n", path: "create.txt" },
        {
          action: "modify",
          edits: [{ newString: "new", oldString: "old" }],
          path: "modify.txt",
        },
        { action: "delete", path: "delete.txt" },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(directory, "create.txt"), "utf-8")).toBe(
      "created\n"
    );
    expect(readFileSync(path.join(directory, "modify.txt"), "utf-8")).toBe(
      "new\n"
    );
    expect(existsSync(path.join(directory, "delete.txt"))).toBe(false);
  });

  test("rejects deleting content changed after preparation", async () => {
    const target = path.join(directory, "delete.txt");
    writeFileSync(target, "original\n");
    const prepared = await prepareFileChanges(directory, [
      { action: "delete", path: "delete.txt" },
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }
    writeFileSync(target, "changed\n");

    const result = await applyPreparedFileChanges(prepared.changes, false);

    expect(result).toMatchObject({
      data: { failed: { code: "stale_content" } },
      ok: false,
    });
    expect(readFileSync(target, "utf-8")).toBe("changed\n");
  });

  test("does not expose source content in an edit failure", async () => {
    const secret = "PRIVATE_VALUE_NOT_FOR_TELEMETRY";
    writeFileSync(path.join(directory, "config.ts"), `${secret}\n`);

    const result = await applyPatchset(
      request(directory, [
        {
          action: "modify",
          edits: [{ newString: "replacement", oldString: "missing" }],
          path: "config.ts",
        },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("rejects paths that escape the project", async () => {
    const result = await applyPatchset(
      request(directory, [
        { action: "create", patch: "outside", path: "../outside.txt" },
      ]),
      { authToken: undefined, dryRun: false }
    );

    expect(result).toMatchObject({
      data: { failed: { code: "invalid_path" } },
      ok: false,
    });
  });
});
