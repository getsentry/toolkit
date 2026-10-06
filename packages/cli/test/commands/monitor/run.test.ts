/**
 * Tests for `sentry monitor run` command func().
 *
 * Uses a real child process (`node -e ...`) to verify exit-code propagation,
 * the `SENTRY_MONITOR_SLUG` env var, and that check-in send failures do not
 * abort the wrapped command. The envelope transport is mocked.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runCommand } from "../../../src/commands/monitor/run.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn
import * as transport from "../../../src/lib/envelope/transport.js";
import { CliError, ValidationError } from "../../../src/lib/errors.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("monitor-run-");

const SAAS_DSN = "https://abc123@o1.ingest.us.sentry.io/999";

const NODE = process.execPath;

function makeContext() {
  return {
    ctx: {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
  };
}

describe("monitor runCommand.func()", () => {
  let func: Awaited<ReturnType<typeof runCommand.loader>>;
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    func = await runCommand.loader();
    sendSpy = vi
      .spyOn(transport, "sendEnvelopeRequest")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  test("sends in_progress then ok check-ins for a successful command", async () => {
    const { ctx } = makeContext();
    await func.call(
      ctx,
      { dsn: SAAS_DSN, environment: "production" },
      "my-job",
      NODE,
      "-e",
      "process.exit(0)"
    );

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const openBody = sendSpy.mock.calls[0]?.[1] as string;
    const closeBody = sendSpy.mock.calls[1]?.[1] as string;
    expect(openBody).toContain('"type":"check_in"');
    expect(openBody).toContain('"status":"in_progress"');
    expect(openBody).toContain('"monitor_slug":"my-job"');
    expect(closeBody).toContain('"status":"ok"');
    // close check-in carries a duration; open does not
    expect(closeBody).toContain('"duration"');
  });

  test("sends error check-in and propagates non-zero exit code", async () => {
    const { ctx } = makeContext();
    await expect(
      func.call(
        ctx,
        { dsn: SAAS_DSN, environment: "production" },
        "my-job",
        NODE,
        "-e",
        "process.exit(3)"
      )
    ).rejects.toMatchObject({ exitCode: 3 });

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const closeBody = sendSpy.mock.calls[1]?.[1] as string;
    expect(closeBody).toContain('"status":"error"');
  });

  test("passes SENTRY_MONITOR_SLUG to the child environment", async () => {
    const { ctx } = makeContext();
    // Child exits 0 only if SENTRY_MONITOR_SLUG matches; else exits 1.
    await func.call(
      ctx,
      { dsn: SAAS_DSN, environment: "production" },
      "env-check-job",
      NODE,
      "-e",
      "process.exit(process.env.SENTRY_MONITOR_SLUG === 'env-check-job' ? 0 : 1)"
    );
    // No throw => exit 0 => env var was present and correct.
    const closeBody = sendSpy.mock.calls[1]?.[1] as string;
    expect(closeBody).toContain('"status":"ok"');
  });

  test("check-in send failure does not abort the wrapped command", async () => {
    sendSpy.mockRejectedValue(new Error("network down"));
    const { ctx } = makeContext();
    // Command still runs and succeeds despite check-in failures.
    await expect(
      func.call(
        ctx,
        { dsn: SAAS_DSN, environment: "production" },
        "my-job",
        NODE,
        "-e",
        "process.exit(0)"
      )
    ).resolves.toBeUndefined();
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  test("upsert config from --schedule appears on the open check-in only", async () => {
    const { ctx } = makeContext();
    await func.call(
      ctx,
      {
        dsn: SAAS_DSN,
        environment: "production",
        schedule: "0 * * * *",
        "max-runtime": 30,
      },
      "scheduled-job",
      NODE,
      "-e",
      "process.exit(0)"
    );

    const openBody = sendSpy.mock.calls[0]?.[1] as string;
    const closeBody = sendSpy.mock.calls[1]?.[1] as string;
    expect(openBody).toContain('"monitor_config"');
    expect(openBody).toContain('"0 * * * *"');
    expect(closeBody).not.toContain('"monitor_config"');
  });

  test("missing command throws ValidationError", async () => {
    const { ctx } = makeContext();
    await expect(
      func.call(ctx, { dsn: SAAS_DSN, environment: "production" }, "my-job")
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("missing monitor slug throws ValidationError", async () => {
    const { ctx } = makeContext();
    await expect(
      func.call(ctx, { dsn: SAAS_DSN, environment: "production" })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("dependent flag without --schedule throws ValidationError", async () => {
    const { ctx } = makeContext();
    await expect(
      func.call(
        ctx,
        { dsn: SAAS_DSN, environment: "production", "max-runtime": 30 },
        "my-job",
        NODE,
        "-e",
        "process.exit(0)"
      )
    ).rejects.toBeInstanceOf(ValidationError);
    // No check-ins sent because validation fails before any send.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test("non-existent binary throws CliError and sends error check-in", async () => {
    const { ctx } = makeContext();
    await expect(
      func.call(
        ctx,
        { dsn: SAAS_DSN, environment: "production" },
        "my-job",
        "this-binary-does-not-exist-xyz"
      )
    ).rejects.toBeInstanceOf(CliError);
    // Both check-ins are still sent; the close one reports an error.
    expect(sendSpy).toHaveBeenCalledTimes(2);
    const closeBody = sendSpy.mock.calls[1]?.[1] as string;
    expect(closeBody).toContain('"status":"error"');
  });
});
