/**
 * Tests for `sentry proguard upload` command.
 *
 * Core invariants (UUID computation, round-trips, determinism) are tested
 * via property-based tests in proguard.property.test.ts. These tests focus
 * on command-level behavior: flag validation, dry-run mode, error paths,
 * and API orchestration.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { uploadCommand } from "../../../src/commands/proguard/upload.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as proguardApi from "../../../src/lib/api/proguard.js";
import { ContextError, ValidationError } from "../../../src/lib/errors.js";

type UploadFuncFlags = {
  uuid?: string;
  "no-upload"?: boolean;
  "require-one"?: boolean;
};

/** The loader returns a wrapped async function, not a raw generator. */
type CmdFunc = (
  this: unknown,
  flags: UploadFuncFlags,
  ...paths: string[]
) => Promise<unknown>;

function makeContext() {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: "/tmp",
  };
}

describe("sentry proguard upload", () => {
  let dir: string;
  let func: CmdFunc;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "sentry-proguard-upload-"));
    savedEnv = {
      SENTRY_ORG: process.env.SENTRY_ORG,
      SENTRY_PROJECT: process.env.SENTRY_PROJECT,
    };
    process.env.SENTRY_ORG = "test-org";
    process.env.SENTRY_PROJECT = "test-project";
    func = (await uploadCommand.loader()) as unknown as CmdFunc;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  // ── Input validation ─────────────────────────────────────────────

  test("no paths: throws ContextError", async () => {
    const ctx = makeContext();
    try {
      await func.call(ctx, {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContextError);
    }
  });

  test("no paths with --require-one: throws ValidationError", async () => {
    const ctx = makeContext();
    try {
      await func.call(ctx, { "require-one": true });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("--require-one");
    }
  });

  test("--uuid with multiple files: throws ValidationError", async () => {
    const f1 = join(dir, "mapping1.txt");
    const f2 = join(dir, "mapping2.txt");
    writeFileSync(f1, "void\n");
    writeFileSync(f2, "other\n");

    const ctx = makeContext();
    try {
      await func.call(
        ctx,
        { uuid: "5db7294d-87fc-5726-a5c0-4a90679657a5" },
        f1,
        f2
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("--uuid");
    }
  });

  test("--uuid with invalid format: throws ValidationError", async () => {
    const f = join(dir, "mapping.txt");
    writeFileSync(f, "void\n");

    const ctx = makeContext();
    try {
      await func.call(ctx, { uuid: "not-a-uuid" }, f);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("Invalid UUID format");
    }
  });

  test("non-existent file: throws ValidationError", async () => {
    const missing = join(dir, "does-not-exist.txt");
    const ctx = makeContext();
    try {
      await func.call(ctx, {}, missing);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("does not exist");
    }
  });

  test("directory path: throws ValidationError", async () => {
    const ctx = makeContext();
    try {
      await func.call(ctx, {}, dir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("directory");
    }
  });

  // ── --no-upload (dry-run) ────────────────────────────────────────

  test("--no-upload: succeeds without uploading", async () => {
    const f = join(dir, "mapping.txt");
    writeFileSync(f, "void\n");

    const ctx = makeContext();
    await func.call(ctx, { "no-upload": true }, f);

    // stdout.write should have been called with output containing the UUID
    expect(ctx.stdout.write).toHaveBeenCalled();
  });

  test("--no-upload: does not require credentials", async () => {
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;

    const f = join(dir, "mapping.txt");
    writeFileSync(f, "void\n");

    const ctx = makeContext();
    // Should succeed without org/project set
    await expect(
      func.call(ctx, { "no-upload": true }, f)
    ).resolves.toBeUndefined();
  });

  // ── Happy path: upload ───────────────────────────────────────────

  test("single file: calls uploadProguardMappings with correct args", async () => {
    const f = join(dir, "mapping.txt");
    writeFileSync(f, "void\n");

    const uploadSpy = vi
      .spyOn(proguardApi, "uploadProguardMappings")
      .mockResolvedValue(undefined);
    try {
      const ctx = makeContext();
      await func.call(ctx, {}, f);

      expect(uploadSpy).toHaveBeenCalledTimes(1);
      const callArgs = uploadSpy.mock.calls[0]?.[0];
      expect(callArgs?.org).toBe("test-org");
      expect(callArgs?.project).toBe("test-project");
      expect(callArgs?.mappings).toHaveLength(1);
      expect(callArgs?.mappings[0]?.uuid).toBe(
        "5db7294d-87fc-5726-a5c0-4a90679657a5"
      );
      expect(callArgs?.mappings[0]?.content).toBeInstanceOf(Buffer);
    } finally {
      uploadSpy.mockRestore();
    }
  });

  test("multiple files: uploads all mappings", async () => {
    const f1 = join(dir, "mapping1.txt");
    const f2 = join(dir, "mapping2.txt");
    writeFileSync(f1, "content one\n");
    writeFileSync(f2, "content two\n");

    const uploadSpy = vi
      .spyOn(proguardApi, "uploadProguardMappings")
      .mockResolvedValue(undefined);
    try {
      const ctx = makeContext();
      await func.call(ctx, {}, f1, f2);

      expect(uploadSpy).toHaveBeenCalledTimes(1);
      const callArgs = uploadSpy.mock.calls[0]?.[0];
      expect(callArgs?.mappings).toHaveLength(2);
      // Different content should yield different UUIDs
      expect(callArgs?.mappings[0]?.uuid).not.toBe(callArgs?.mappings[1]?.uuid);
    } finally {
      uploadSpy.mockRestore();
    }
  });

  test("--uuid: forces specific UUID for single file upload", async () => {
    const f = join(dir, "mapping.txt");
    writeFileSync(f, "void\n");
    const forcedUuid = "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee";

    const uploadSpy = vi
      .spyOn(proguardApi, "uploadProguardMappings")
      .mockResolvedValue(undefined);
    try {
      const ctx = makeContext();
      await func.call(ctx, { uuid: forcedUuid }, f);

      const callArgs = uploadSpy.mock.calls[0]?.[0];
      expect(callArgs?.mappings[0]?.uuid).toBe(forcedUuid);
    } finally {
      uploadSpy.mockRestore();
    }
  });
});
