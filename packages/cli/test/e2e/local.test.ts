/** Real CLI process coverage for daemon discovery, isolated telemetry and leases. */
import { createServer } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { runCli } from "../fixture.js";
import { useTestConfigDir } from "../helpers.js";

/** Capability URLs returned explicitly by session creation. */
type Session = {
  id: string;
  ingestUrl: string;
  streamUrl: string;
};

const fetch = (globalThis as { __originalFetch: typeof globalThis.fetch })
  .__originalFetch;
const getConfigDir = useTestConfigDir("local-e2e-");

async function cli(...args: string[]) {
  return runCli(["local", ...args, "--json"], {
    env: {
      SENTRY_CONFIG_DIR: getConfigDir(),
      SENTRY_CLI_NO_TELEMETRY: "1",
      SENTRY_AUTH_TOKEN: "",
      SENTRY_TOKEN: "",
    },
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function createSession(label: string, port: number): Promise<Session> {
  const result = await cli(
    "session",
    "create",
    label,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  );
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Session;
}

async function ingest(session: Session, eventId: string, message: string) {
  const response = await fetch(session.ingestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope" },
    body: `${JSON.stringify({ event_id: eventId })}\n{"type":"event"}\n${JSON.stringify({ event_id: eventId, message })}`,
  });
  expect(response.status).toBe(204);
}

afterEach(async () => {
  await cli("daemon", "stop");
  await expect
    .poll(
      async () => {
        const status = await cli("daemon", "status");
        return JSON.parse(status.stdout) as unknown;
      },
      { timeout: 10_000 },
    )
    .toEqual({ daemon: null });
});

describe("Local daemon E2E", () => {
  test("isolates sessions and capabilities, queries retained telemetry and clears only one session", async () => {
    const port = await availablePort();
    const [web, worker] = await Promise.all([
      createSession("web", port),
      createSession("worker", port),
    ]);
    expect(web.id).not.toBe(worker.id);
    const statePath = join(getConfigDir(), "local-control-plane.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      token: string;
      host: string;
      port: number;
    };
    if (process.platform !== "win32") {
      expect((await stat(statePath)).mode % 0o1000).toBe(0o600);
    }
    const status = await cli("daemon", "status");
    expect(status.stdout).not.toContain(state.token);
    const base = `http://${state.host}:${state.port}/_local/v1`;
    expect((await fetch(`${base}/sessions`)).status).toBe(401);
    expect(
      (await fetch(web.streamUrl, { method: "POST", body: "invalid" })).status,
    ).toBe(401);
    const wrongSession = new URL(web.ingestUrl);
    wrongSession.pathname = wrongSession.pathname.replace(web.id, worker.id);
    expect(
      (await fetch(wrongSession, { method: "POST", body: "invalid" })).status,
    ).toBe(401);

    await ingest(web, "a".repeat(32), "web event");
    await ingest(worker, "b".repeat(32), "worker event");
    const listed = await cli("event", "list", "web");
    expect(listed.exitCode, listed.stderr).toBe(0);
    const events = JSON.parse(listed.stdout) as {
      events: { eventId: string; envelopeId: string }[];
    };
    expect(events.events).toHaveLength(1);
    expect(events.events[0]?.eventId).toBe("a".repeat(32));
    const viewed = await cli("event", "view", web.id, "a".repeat(32));
    expect(viewed.exitCode, viewed.stderr).toBe(0);
    expect(viewed.stdout).toContain("web event");
    expect(viewed.stdout).not.toContain("worker event");
    const raw = await cli(
      "envelope",
      "view",
      web.id,
      events.events[0]?.envelopeId ?? "",
    );
    expect(raw.exitCode, raw.stderr).toBe(0);
    const envelope = JSON.parse(raw.stdout) as { data: string };
    expect(Buffer.from(envelope.data, "base64").toString()).toContain(
      "web event",
    );

    const stream = await fetch(web.streamUrl, {
      signal: AbortSignal.timeout(5000),
    });
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("web event");
    await reader?.cancel();
    const resetUrl = new URL(web.streamUrl);
    resetUrl.pathname = resetUrl.pathname.replace(/\/stream$/, "/ui/reset");
    expect(
      (
        await fetch(resetUrl, {
          method: "POST",
          headers: { Origin: "https://example.com" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(resetUrl, {
          method: "POST",
          headers: { Origin: "http://localhost:5173" },
        })
      ).status,
    ).toBe(204);
    expect(JSON.parse((await cli("event", "list", "web")).stdout)).toEqual({
      events: [],
    });
    expect((await cli("event", "list", "worker")).stdout).toContain(
      "b".repeat(32),
    );
    const closed = await cli("session", "close", worker.id);
    expect(closed.exitCode, closed.stderr).toBe(0);
    expect(JSON.parse(closed.stdout)).toMatchObject({
      id: worker.id,
      state: "retained",
    });
    expect(
      (await cli("event", "view", worker.id, "b".repeat(32))).stdout,
    ).toContain("worker event");
  }, 30_000);

  test("views telemetry using quoted and split multi-word session names", async () => {
    const session = await createSession("My App", await availablePort());
    const eventId = "d".repeat(32);
    await ingest(session, eventId, "multi-word session event");
    const listed = await cli("event", "list", "My", "App");
    expect(listed.exitCode, listed.stderr).toBe(0);
    const { events } = JSON.parse(listed.stdout) as {
      events: { envelopeId: string }[];
    };
    const envelopeId = events[0]?.envelopeId;
    expect(envelopeId).toBeDefined();
    for (const parts of [["My App"], ["My", "App"]]) {
      const event = await cli("event", "view", ...parts, eventId);
      expect(event.exitCode, event.stderr).toBe(0);
      expect(event.stdout).toContain("multi-word session event");
      const raw = await cli("envelope", "view", ...parts, envelopeId!);
      expect(raw.exitCode, raw.stderr).toBe(0);
      const envelope = JSON.parse(raw.stdout) as { data: string };
      expect(Buffer.from(envelope.data, "base64").toString()).toContain(
        "multi-word session event",
      );
    }
    for (const command of ["event", "envelope"]) {
      const missingId = await cli(command, "view", session.id);
      expect(missingId.exitCode).not.toBe(0);
      expect(missingId.stderr).toContain(`Provide a session and ${command} ID`);
    }
  }, 30_000);

  test("retains a wrapped application's session and injects scoped SDK URLs", async () => {
    const port = await availablePort();
    const script = join(getConfigDir(), "app.cjs");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      script,
      `const url = process.env.SENTRY_SPOTLIGHT;
      if (url !== process.env.VITE_SENTRY_SPOTLIGHT) process.exit(2);
      fetch(url, {method:'POST', headers:{'Content-Type':'application/x-sentry-envelope'},
      body:'{"event_id":"${"c".repeat(32)}"}\\n{"type":"event"}\\n{"message":"wrapped app"}'})
      .then(r => {if (r.status !== 204) process.exitCode=3; console.error('app completed');})
      .catch(() => {process.exitCode=4;});`,
    );
    const result = await runCli(
      [
        "local",
        "run",
        "--session",
        "wrapped",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--format",
        "json",
        "--",
        process.execPath,
        script,
      ],
      {
        env: {
          SENTRY_CONFIG_DIR: getConfigDir(),
          SENTRY_CLI_NO_TELEMETRY: "1",
          SENTRY_AUTH_TOKEN: "",
          SENTRY_TOKEN: "",
        },
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("app completed");
    expect(result.stdout).toContain("wrapped app");
    const listed = await cli("session", "list");
    expect(JSON.parse(listed.stdout)).toMatchObject({
      sessions: [{ label: "wrapped", state: "retained" }],
    });
    expect(
      (await cli("event", "view", "wrapped", "c".repeat(32))).stdout,
    ).toContain("wrapped app");
  }, 30_000);

  test("captures telemetry from the real Sentry Node SDK through the injected URL", async () => {
    const port = await availablePort();
    const result = await runCli(
      [
        "local",
        "run",
        "--session",
        "sdk",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--format",
        "json",
        "--",
        process.execPath,
        "--input-type=module",
        "-e",
        `import * as Sentry from '@sentry/node';
        Sentry.init({enableLogs: true, tracesSampleRate: 1});
        const id = Sentry.captureException(new Error('Local real SDK event'));
        console.error('SDK_EVENT:' + id);
        await Sentry.flush(2000);
        await new Promise(resolve => setTimeout(resolve, 500));
        await Sentry.close(1000);`,
      ],
      {
        env: {
          SENTRY_CONFIG_DIR: getConfigDir(),
          SENTRY_CLI_NO_TELEMETRY: "1",
          SENTRY_AUTH_TOKEN: "",
          SENTRY_TOKEN: "",
          SENTRY_DSN: "",
        },
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const eventId = result.stderr.match(/SDK_EVENT:([a-f0-9]{32})/)?.[1];
    expect(eventId, result.stderr).toBeDefined();
    expect(result.stdout).toContain("Local real SDK event");
    const session = JSON.parse(
      (await cli("session", "view", "sdk")).stdout,
    ) as Session;
    expect(result.stderr).toContain("configured for session");
    expect(result.stderr).toContain("session view");
    expect(result.stderr).not.toContain(
      new URL(session.ingestUrl).pathname.split("/").at(-1),
    );
    expect((await cli("event", "list", "sdk")).stdout).toContain(eventId);
    expect((await cli("event", "view", "sdk", eventId ?? "")).stdout).toContain(
      "Local real SDK event",
    );
  }, 30_000);

  test("waits for the port retry window during concurrent daemon startup", async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP address");
    const pending = Promise.allSettled([
      createSession("retry-a", address.port),
      createSession("retry-b", address.port),
    ]);
    try {
      await sleep(6500);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const results = await pending;
      if (results.some((result) => result.status === "rejected"))
        await sleep(5000);
      expect(results.map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      expect(
        JSON.parse((await cli("session", "list")).stdout).sessions,
      ).toHaveLength(2);
    } finally {
      server.close();
    }
  }, 30_000);

  test("reports a failed daemon startup without leaving an owner or late listener", async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP address");
    try {
      const result = await cli(
        "daemon",
        "start",
        "--host",
        "127.0.0.1",
        "--port",
        String(address.port),
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("exited before startup");
      for (const filename of [
        "local-control-plane.owner",
        "local-control-plane.lock",
      ]) {
        await expect(
          readFile(join(getConfigDir(), filename), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sleep(1000);
      expect(JSON.parse((await cli("daemon", "status")).stdout)).toEqual({
        daemon: null,
      });
    } finally {
      server.close();
    }
  }, 30_000);

  test("rejects legacy commands before running an app against the managed daemon", async () => {
    const port = await availablePort();
    await createSession("managed", port);
    const result = await runCli(
      [
        "local",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--",
        process.execPath,
        "-e",
        "console.error('LEGACY_CHILD_RAN')",
      ],
      {
        env: {
          SENTRY_CONFIG_DIR: getConfigDir(),
          SENTRY_CLI_NO_TELEMETRY: "1",
        },
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--session");
    expect(result.stderr).not.toContain("LEGACY_CHILD_RAN");
    const serve = await runCli(
      ["local", "serve", "--host", "127.0.0.1", "--port", String(port)],
      {
        env: {
          SENTRY_CONFIG_DIR: getConfigDir(),
          SENTRY_CLI_NO_TELEMETRY: "1",
          SENTRY_AUTH_TOKEN: "",
          SENTRY_TOKEN: "",
        },
      },
    );
    expect(serve.exitCode).not.toBe(0);
    expect(serve.stderr).toContain("--session");
  }, 30_000);

  test("restarts on the configured port and preserves singleton discovery", async () => {
    const port = await availablePort();
    await createSession("restart", port);
    const result = await cli("daemon", "restart");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      host: "127.0.0.1",
      port,
    });
    await sleep(100);
    expect((await cli("daemon", "status")).exitCode).toBe(0);
  }, 30_000);
});

describe("Local foreground commands", () => {
  test("serve consumes the scoped stream and a second foreground daemon cannot replace discovery", async () => {
    const { spawn } = await import("node:child_process");
    const { getCliCommand } = await import("../fixture.js");
    const port = await availablePort();
    const session = await createSession("existing", port);
    const before = await readFile(
      join(getConfigDir(), "local-control-plane.json"),
      "utf8",
    );
    const rejected = await cli(
      "daemon",
      "start",
      "--foreground",
      "--host",
      "127.0.0.1",
      "--port",
      String(await availablePort()),
    );
    expect(rejected.exitCode).not.toBe(0);
    expect(
      await readFile(join(getConfigDir(), "local-control-plane.json"), "utf8"),
    ).toBe(before);
    const [executable, ...prefix] = getCliCommand();
    if (!executable) throw new Error("Missing CLI executable");
    const child = spawn(
      executable,
      [
        ...prefix,
        "local",
        "serve",
        "--session",
        "serve-e2e",
        "--format",
        "json",
      ],
      {
        cwd: join(import.meta.dirname, "../.."),
        env: {
          ...process.env,
          SENTRY_CONFIG_DIR: getConfigDir(),
          SENTRY_CLI_NO_TELEMETRY: "1",
          SENTRY_AUTH_TOKEN: "",
          SENTRY_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });
    try {
      await expect
        .poll(
          async () => {
            const listed = JSON.parse(
              (await cli("session", "list")).stdout,
            ) as { sessions: { label: string; id: string }[] };
            return listed.sessions.find((item) => item.label === "serve-e2e")
              ?.id;
          },
          { timeout: 10000 },
        )
        .toBeDefined();
      const listed = JSON.parse((await cli("session", "list")).stdout) as {
        sessions: { label: string; id: string }[];
      };
      const id = listed.sessions.find((item) => item.label === "serve-e2e")?.id;
      if (!id) throw new Error("Missing serve session");
      const scoped = JSON.parse(
        (await cli("session", "view", id)).stdout,
      ) as Session;
      await ingest(scoped, "e".repeat(32), "serve session");
      await expect
        .poll(() => stdout, { timeout: 5000 })
        .toContain("serve session");
      await ingest(session, "d".repeat(32), "other session");
      expect(stdout).not.toContain("other session");
      expect(child.exitCode, stderr).toBeNull();
      await cli("session", "close", id);
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
  }, 30000);
});
