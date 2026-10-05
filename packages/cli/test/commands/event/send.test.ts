/**
 * Tests for `sentry event send` command func().
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sendCommand } from "../../../src/commands/event/send.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn
import * as dsnIndex from "../../../src/lib/dsn/index.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn
import * as eventSendDsn from "../../../src/lib/envelope/event-send-dsn.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn
import * as transport from "../../../src/lib/envelope/transport.js";
import { ConfigError, ValidationError } from "../../../src/lib/errors.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("send-event-");

const SAAS_DSN = "https://abc123@o1.ingest.us.sentry.io/999";

function makeContext() {
  const writes: string[] = [];
  return {
    ctx: {
      stdout: {
        write: (s: string) => {
          writes.push(s);
          return true;
        },
      },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    writes,
  };
}

describe("sendCommand.func()", () => {
  let func: Awaited<ReturnType<typeof sendCommand.loader>>;
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let detectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.stubEnv("SENTRY_DSN", "");
    func = await sendCommand.loader();
    sendSpy = vi
      .spyOn(transport, "sendEnvelopeRequest")
      .mockResolvedValue(undefined);
    detectSpy = vi.spyOn(dsnIndex, "detectDsn").mockResolvedValue(null);
  });

  afterEach(() => {
    sendSpy.mockRestore();
    detectSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  test("inline message sends an envelope and prints event ID", async () => {
    const { ctx, writes } = makeContext();
    await func.call(
      ctx,
      {
        message: ["Test message"],
        level: "error",
        "no-environ": true,
      },
      SAAS_DSN
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [calledDsn, calledBody] = sendSpy.mock.calls[0] as [string, string];
    expect(calledDsn).toBe(SAAS_DSN);
    expect(calledBody).toContain('"type":"event"');

    const output = writes.join("");
    expect(output).toContain("Event dispatched");
    expect(output).toMatch(/[0-9a-f]{32}/); // event ID in output
  });

  test("--level flag is included in envelope body", async () => {
    const { ctx } = makeContext();
    await func.call(
      ctx,
      {
        message: ["boom"],
        level: "fatal",
        "no-environ": true,
      },
      SAAS_DSN
    );

    const body = sendSpy.mock.calls[0]?.[1] as string;
    expect(body).toContain('"level":"fatal"');
  });

  test("--tag pairs appear in envelope body", async () => {
    const { ctx } = makeContext();
    await func.call(
      ctx,
      {
        message: ["hi"],
        tag: ["env:prod", "region:us"],
        "no-environ": true,
      },
      SAAS_DSN
    );

    const body = sendSpy.mock.calls[0]?.[1] as string;
    expect(body).toContain('"env":"prod"');
    expect(body).toContain('"region":"us"');
  });

  test("missing DSN throws ConfigError", async () => {
    const { ctx } = makeContext();
    await expect(func.call(ctx, { "no-environ": true })).rejects.toBeInstanceOf(
      ConfigError
    );
  });

  test("auto-detected DSN is used when flag and env are absent", async () => {
    detectSpy.mockResolvedValue({
      raw: SAAS_DSN,
      protocol: "https",
      publicKey: "abc123",
      host: "o1.ingest.us.sentry.io",
      projectId: "999",
      source: "env_file",
    });
    const { ctx } = makeContext();
    await func.call(ctx, {
      message: ["from scan"],
      level: "error",
      "no-environ": true,
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0]).toBe(SAAS_DSN);
  });

  test("org/project positional is passed as a project target, not a file", async () => {
    const resolveSpy = vi
      .spyOn(eventSendDsn, "resolveEventSendDsn")
      .mockResolvedValue(SAAS_DSN);
    const { ctx } = makeContext();
    try {
      await func.call(
        ctx,
        {
          message: ["from org/project"],
          level: "error",
          "no-environ": true,
        },
        "grow-together-therapy/javascript-react"
      );
      expect(resolveSpy).toHaveBeenCalledWith("/tmp", {
        kind: "project",
        target: "grow-together-therapy/javascript-react",
      });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0]?.[0]).toBe(SAAS_DSN);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  test("--json outputs JSON with eventId field", async () => {
    const { ctx, writes } = makeContext();
    await func.call(
      ctx,
      {
        message: ["hello"],
        json: true,
        "no-environ": true,
      },
      SAAS_DSN
    );

    const output = writes.join("");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("eventId");
    expect(parsed.eventId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("nonexistent file throws ValidationError (not raw stack trace)", async () => {
    const { ctx } = makeContext();

    await expect(
      func.call(
        ctx,
        { "no-environ": true },
        SAAS_DSN,
        "/nonexistent/missing.json"
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("--raw requires file arguments", async () => {
    const { ctx } = makeContext();

    await expect(
      func.call(ctx, { raw: true, "no-environ": true }, SAAS_DSN)
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
