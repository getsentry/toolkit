/** Real CLI process coverage for daemon discovery, isolated telemetry and leases. */
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { rmSync } from "node:fs";
import { readFile, stat, rm, utimes, writeFile } from "node:fs/promises";
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
  directoryUrl: string;
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

async function createSession(
  label: string,
  port: number,
  maxEnvelopes?: number,
): Promise<Session> {
  const result = await cli(
    "session",
    "create",
    label,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    ...(maxEnvelopes === undefined
      ? []
      : ["--max-envelopes", String(maxEnvelopes)]),
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
  test("hosted session discovery switches isolated streams and preserves retained sessions", async () => {
    const port = await availablePort();
    const web = await createSession("web", port);
    const worker = await createSession("worker", port);
    await ingest(web, "web-id", "web-only");
    await ingest(worker, "worker-id", "worker-only");
    const origin = { Origin: "https://local.sentry.dev" };
    const response = await fetch(web.directoryUrl, { headers: origin });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://local.sentry.dev",
    );
    const directory = (await response.json()) as {
      sessions: {
        id: string;
        label: string;
        state: string;
        streamUrl: string;
      }[];
    };
    expect(directory.sessions).toHaveLength(2);
    expect(JSON.stringify(directory)).not.toContain("ingestUrl");
    for (const [id, expected, excluded] of [
      [web.id, "web-only", "worker-only"],
      [worker.id, "worker-only", "web-only"],
      [web.id, "web-only", "worker-only"],
    ]) {
      const session = directory.sessions.find((s) => s.id === id)!;
      const stream = await fetch(session.streamUrl, {
        headers: origin,
        signal: AbortSignal.timeout(5000),
      });
      const reader = stream.body!.getReader();
      try {
        let text = "";
        while (!text.includes(expected!)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Stream closed");
          text += new TextDecoder().decode(chunk.value);
        }
        expect(text).not.toContain(excluded!);
      } finally {
        await reader.cancel();
      }
    }
    const wrong = new URL(web.directoryUrl);
    wrong.searchParams.set(
      "cap",
      new URL(web.streamUrl).searchParams.get("cap")!,
    );
    expect((await fetch(wrong, { headers: origin })).status).toBe(401);
    const preflight = await fetch(web.directoryUrl, {
      method: "OPTIONS",
      headers: {
        ...origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe(
      "true",
    );
    expect(
      (
        await fetch(web.directoryUrl, {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(web.directoryUrl, { method: "POST", headers: origin }))
        .status,
    ).toBe(403);
    expect((await cli("session", "close", worker.id)).exitCode).toBe(0);
    const refreshed = (await (
      await fetch(web.directoryUrl, { headers: origin })
    ).json()) as typeof directory;
    expect(refreshed.sessions.find((s) => s.id === worker.id)?.state).toBe(
      "retained",
    );
    expect(
      JSON.parse((await cli("event", "list", worker.id)).stdout).events,
    ).toHaveLength(1);
  }, 30_000);

  test.each(
    ["stop", "restart"].flatMap((command) =>
      ["delayed", "rejected", "never", "hung"].map((mode) => ({
        command,
        mode,
      })),
    ),
  )(
    "$command handles $mode shutdown without reporting completion early",
    async ({ command, mode }) => {
      const token = "restart-fixture";
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const statePath = join(getConfigDir(), "local-control-plane.json");
      const ownerPath = join(getConfigDir(), "local-control-plane.owner");
      const server = createHttpServer((request, response) => {
        if (request.url?.endsWith("/daemon/stop")) {
          if (mode === "hung") return;
          response.statusCode = mode === "rejected" ? 401 : 202;
          response.end();
          if (mode === "delayed") {
            setImmediate(() => {
              server.close();
              server.closeAllConnections();
            });
            cleanupTimer = setTimeout(() => {
              rmSync(statePath, { force: true });
              rmSync(ownerPath, { force: true });
            }, 350);
          }
        } else {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ sessions: [] }));
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP address");
      const before = {
        host: "127.0.0.1",
        port: address.port,
        pid: process.pid,
        token,
        version: 1,
      };
      await writeFile(statePath, JSON.stringify(before));
      await writeFile(ownerPath, String(process.pid));
      try {
        const result = await cli("daemon", command);
        if (mode === "delayed") {
          expect(result.exitCode, result.stderr).toBe(0);
          if (command === "restart") {
            expect(JSON.parse(result.stdout)).toMatchObject({
              host: before.host,
              port: before.port,
            });
            const after = JSON.parse(await readFile(statePath, "utf8")) as {
              pid: number;
            };
            expect(after.pid).not.toBe(before.pid);
          } else {
            expect(JSON.parse(result.stdout)).toEqual({ stopped: true });
            await expect(readFile(statePath, "utf8")).rejects.toMatchObject({
              code: "ENOENT",
            });
            await expect(readFile(ownerPath, "utf8")).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        } else {
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain(
            mode === "rejected" ? "HTTP 401" : "Timed out",
          );
          expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(before);
        }
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        if (server.listening)
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          });
        const remaining = await readFile(statePath, "utf8").catch(() => "null");
        const current = JSON.parse(remaining) as {
          pid?: number;
          token?: string;
        } | null;
        if (current?.pid === before.pid && current.token === before.token) {
          await rm(statePath, { force: true });
          await rm(ownerPath, { force: true });
        }
      }
    },
    30_000,
  );

  test("surfaces duplicate session name guidance through the CLI", async () => {
    const port = await availablePort();
    const first = await createSession("duplicate", port);
    await createSession("duplicate", port);
    for (const parts of [
      ["session", "view"],
      ["session", "close"],
      ["event", "list"],
      ["envelope", "list"],
    ]) {
      const result = await cli(...parts, "duplicate");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("ambiguous; use its session ID");
    }
    expect((await cli("session", "view", first.id)).exitCode).toBe(0);
  }, 30_000);

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

  test("configures retention and grows a live session without losing history or replaying duplicates", async () => {
    const session = await createSession("limits", await availablePort(), 2);
    await ingest(session, "one", "one");
    await ingest(session, "two", "two");
    const before = JSON.parse(
      (await cli("event", "list", session.id)).stdout,
    ).events;
    const streamUrl = new URL(session.streamUrl);
    streamUrl.searchParams.set("retention", "1");
    const response = await fetch(streamUrl, {
      signal: AbortSignal.timeout(30000),
    });
    const reader = response.body!.getReader();
    let text = "";
    async function until(marker: string) {
      while (!text.includes(marker)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream closed");
        text += new TextDecoder().decode(chunk.value);
      }
    }
    try {
      await until('"message":"two"');
      const grown = await cli(
        "session",
        "retention",
        session.id,
        "--max-envelopes",
        "4",
      );
      expect(grown.exitCode, grown.stderr).toBe(0);
      expect(JSON.parse(grown.stdout)).toMatchObject({
        maxEnvelopes: 4,
        retainedEnvelopes: 2,
      });
      await until('"maxEnvelopes":4');
      await ingest(session, "three", "three");
      await ingest(session, "four", "four");
      await until('"message":"four"');
      expect(text.match(/"message":"one"/g)).toHaveLength(1);
      const after = JSON.parse(
        (await cli("event", "list", session.id)).stdout,
      ).events;
      expect(after).toHaveLength(4);
      for (const event of before) expect(after).toContainEqual(event);
      const rejected = await cli(
        "session",
        "retention",
        session.id,
        "--max-envelopes",
        "3",
      );
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toContain("4 retained envelopes");
      const uiUrl = new URL(session.streamUrl);
      uiUrl.pathname = uiUrl.pathname.replace(/stream$/, "ui/retention");
      const updated = await fetch(uiUrl, {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ maxEnvelopes: 6 }),
      });
      expect(updated.status).toBe(200);
      await until('"maxEnvelopes":6');
      expect(
        JSON.parse((await cli("event", "list", session.id)).stdout).events,
      ).toHaveLength(4);
      const reset = new URL(session.streamUrl);
      reset.pathname = reset.pathname.replace(/stream$/, "ui/reset");
      expect((await fetch(reset, { method: "POST" })).status).toBe(204);
      expect(
        (await cli("session", "retention", session.id, "--max-envelopes", "1"))
          .exitCode,
      ).toBe(0);
      await ingest(session, "five", "five");
      await ingest(session, "six", "six");
      expect(
        JSON.parse((await cli("event", "list", session.id)).stdout).events,
      ).toMatchObject([{ eventId: "six" }]);
    } finally {
      await reader.cancel();
    }
    for (const value of ["0", "1.5", "50001"]) {
      const invalid = await cli(
        "session",
        "create",
        "invalid",
        "--max-envelopes",
        value,
      );
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain("Retention limit must be an integer");
    }
  }, 30_000);

  test("queries SDK event IDs from item headers and payloads", async () => {
    const session = await createSession("sdk IDs", await availablePort());
    for (const [itemHeader, payload] of [
      [{ type: "event", event_id: "item-event" }, { message: "item ID event" }],
      [
        { type: "transaction" },
        { event_id: "payload-event", transaction: "payload ID transaction" },
      ],
    ]) {
      const response = await fetch(session.ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope" },
        body: [{ sdk: { name: "sentry.node" } }, itemHeader, payload]
          .map((value) => JSON.stringify(value))
          .join("\n"),
      });
      expect(response.status).toBe(204);
    }
    const listed = await cli("event", "list", session.id);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(
      JSON.parse(listed.stdout)
        .events.map((event: { eventId: string }) => event.eventId)
        .sort(),
    ).toEqual(["item-event", "payload-event"]);
    for (const eventId of ["item-event", "payload-event"]) {
      const viewed = await cli("event", "view", session.id, eventId);
      expect(viewed.exitCode, viewed.stderr).toBe(0);
      expect(JSON.parse(viewed.stdout).eventId).toBe(eventId);
    }
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
        "--max-envelopes",
        "1000",
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
      sessions: [{ label: "wrapped", state: "retained", maxEnvelopes: 1000 }],
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

  test("recovers an expired incomplete owner and preserves live singleton ownership", async () => {
    const owner = join(getConfigDir(), "local-control-plane.owner");
    await writeFile(owner, "");
    const expired = new Date(Date.now() - 6000);
    await utimes(owner, expired, expired);
    const first = await createSession("reclaimed-owner", await availablePort());
    const pid = await readFile(owner, "utf8");
    expect(Number(pid)).toBeGreaterThan(0);
    await createSession("same-owner", await availablePort());
    expect(await readFile(owner, "utf8")).toBe(pid);
    await ingest(first, "owner-recovery", "recovered receiver");
    expect(
      JSON.parse((await cli("event", "list", first.id)).stdout),
    ).toMatchObject({
      events: [{ eventId: "owner-recovery" }],
    });
    expect(
      (await cli("event", "view", first.id, "owner-recovery")).stdout,
    ).toContain("recovered receiver");
    await cli("daemon", "stop");
    await expect(readFile(owner, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30000);

  test("attaches to a foreground daemon that owns startup before discovery is published", async () => {
    const { spawn } = await import("node:child_process");
    const { getCliCommand } = await import("../fixture.js");
    const reserve = createServer();
    await new Promise<void>((resolve) =>
      reserve.listen(0, "127.0.0.1", resolve),
    );
    const address = reserve.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address");
    const [executable, ...prefix] = getCliCommand();
    if (!executable) throw new Error("Missing CLI executable");
    const foreground = spawn(
      executable,
      [
        ...prefix,
        "local",
        "daemon",
        "start",
        "--foreground",
        "--host",
        "127.0.0.1",
        "--port",
        String(address.port),
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
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    foreground.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<void>((resolve, reject) => {
      foreground.once("close", () => resolve());
      foreground.once("error", reject);
    });
    let pending: ReturnType<typeof cli> | undefined;
    try {
      const owner = join(getConfigDir(), "local-control-plane.owner");
      await expect
        .poll(
          async () => Number(await readFile(owner, "utf8").catch(() => "0")),
          { timeout: 10000 },
        )
        .toBe(foreground.pid);
      await expect(
        readFile(join(getConfigDir(), "local-control-plane.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      pending = cli(
        "session",
        "create",
        "foreground-race",
        "--host",
        "127.0.0.1",
        "--port",
        String(address.port),
      );
      // Keep foreground startup inside the real listener retry window while the client joins it.
      await sleep(6500);
      await new Promise<void>((resolve) => reserve.close(() => resolve()));
      const result = await pending;
      expect(result.exitCode, result.stderr).toBe(0);
      const session = JSON.parse(result.stdout) as Session;
      const state = JSON.parse(
        await readFile(
          join(getConfigDir(), "local-control-plane.json"),
          "utf8",
        ),
      ) as { pid: number };
      expect(state.pid, stderr).toBe(foreground.pid);
      await ingest(session, "foreground-owner", "foreground capture");
      expect(
        (await cli("event", "view", session.id, "foreground-owner")).stdout,
      ).toContain("foreground capture");
    } finally {
      reserve.close();
      await cli("daemon", "stop");
      foreground.kill("SIGTERM");
      await closed;
      await pending;
    }
  }, 30000);

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
  test("rejects verification with a retained session before running the application", async () => {
    const marker = join(getConfigDir(), "verify-session-child-ran");
    const script = join(getConfigDir(), "verify-session-child.cjs");
    await writeFile(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`,
    );
    const result = await runCli(
      [
        "local",
        "run",
        "--session",
        "verification",
        "--verify",
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
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--session cannot be used with --verify.");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(JSON.parse((await cli("daemon", "status")).stdout)).toEqual({
      daemon: null,
    });
  });

  test("run configures a plain receiver and explicit attachment preserves retained envelopes", async () => {
    const { createLocalRetentionBuffer } =
      await import("../../src/commands/local/retention-buffer.js");
    const { buildApp, tryListen } =
      await import("../../src/commands/local/server.js");
    const retention = createLocalRetentionBuffer(2);
    const receiver = await tryListen(
      buildApp(retention.buffer, { uiActions: true, retention }),
      0,
      "127.0.0.1",
    );
    const script = join(getConfigDir(), "legacy-app.cjs");
    await writeFile(
      script,
      `fetch(new URL('/capabilities',process.env.SENTRY_SPOTLIGHT)).then(r=>r.json()).then(settings=>{console.log('limit='+settings.maxEnvelopes);if(settings.maxEnvelopes!==1000)process.exitCode=2;});`,
    );
    try {
      await fetch(`http://127.0.0.1:${receiver.port}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope" },
        body: '{}\n{"type":"event"}\n{"message":"preserved"}',
      });
      const before = retention.buffer.read({ all: true });
      for (const explicit of [true, false]) {
        const result = await runCli(
          [
            "local",
            "run",
            "--host",
            "127.0.0.1",
            "--port",
            String(receiver.port),
            ...(explicit ? ["--max-envelopes", "1000"] : []),
            "--",
            process.execPath,
            script,
          ],
          {
            env: {
              SENTRY_CONFIG_DIR: getConfigDir(),
              SENTRY_CLI_NO_TELEMETRY: "1",
            },
          },
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain("limit=1000");
        expect(retention.buffer.read({ all: true })).toEqual(before);
      }
      const created = await runCli(
        [
          "local",
          "run",
          "--host",
          "127.0.0.1",
          "--port",
          String(await availablePort()),
          "--max-envelopes",
          "1000",
          "--",
          process.execPath,
          script,
        ],
        {
          env: {
            SENTRY_CONFIG_DIR: getConfigDir(),
            SENTRY_CLI_NO_TELEMETRY: "1",
          },
        },
      );
      expect(created.exitCode, created.stderr).toBe(0);
      expect(created.stdout).toContain("limit=1000");
    } finally {
      receiver.server.closeAllConnections();
      await new Promise<void>((resolve) =>
        receiver.server.close(() => resolve()),
      );
    }
  }, 30000);

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
        "--max-envelopes",
        "1500",
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
      expect(
        JSON.parse((await cli("session", "retention", id)).stdout).maxEnvelopes,
      ).toBe(1500);
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
