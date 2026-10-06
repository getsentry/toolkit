/**
 * Tests for `sentry send-envelope` deprecation shim.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { sendEnvelopeCommand } from "../../src/commands/send-envelope.js";
import { CliError } from "../../src/lib/errors.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("send-envelope-");

function makeContext() {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: "/tmp",
  };
}

describe("sendEnvelopeCommand (deprecation shim)", () => {
  let func: Awaited<ReturnType<typeof sendEnvelopeCommand.loader>>;

  beforeEach(async () => {
    func = await sendEnvelopeCommand.loader();
  });

  test("throws CliError suggesting event send --raw", async () => {
    const ctx = makeContext();
    await expect(
      func.call(
        ctx,
        { dsn: "https://x@o1.ingest.sentry.io/1" },
        "file.envelope"
      )
    ).rejects.toBeInstanceOf(CliError);
  });

  test("error message includes the file argument", async () => {
    const ctx = makeContext();
    try {
      await func.call(
        ctx,
        { dsn: "https://x@o1.ingest.sentry.io/1" },
        "my.envelope"
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as CliError).message).toContain("sentry event send --raw");
      expect((err as CliError).message).toContain("my.envelope");
    }
  });

  test("error message uses placeholder when no files given", async () => {
    const ctx = makeContext();
    try {
      await func.call(ctx, { dsn: "https://x@o1.ingest.sentry.io/1" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as CliError).message).toContain(
        "sentry event send --raw <file>"
      );
    }
  });
});
