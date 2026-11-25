/** Real CLI process coverage for daemon discovery, isolated telemetry and leases. */
import { execFile, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { rmSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  stat,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { runCli } from "../fixture.js";
import { at, must, useTestConfigDir } from "../helpers.js";

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
  return await runCli(["local", ...args, "--json"], {
    env: {
      SENTRY_CONFIG_DIR: getConfigDir(),
      SENTRY_CLI_NO_TELEMETRY: "1",
      SENTRY_AUTH_TOKEN: "",
      SENTRY_TOKEN: "",
    },
  });
}

/**
 * A TCP listener that holds a port and never answers. It reads what clients
 * send, so it sees them disconnect and `close()` does not wait on them.
 */
function createSilentServer() {
  return createServer((socket) => socket.resume());
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

/**
 * Ports Node's fetch refuses to dial ("bad port"), though a server can bind
 * them. Returns one that is free here, or undefined if all are taken.
 */
async function freeFetchBlockedPort(): Promise<number | undefined> {
  for (const port of [6000, 6665, 6666, 6667, 6668, 6669, 6697, 10080]) {
    const server = createServer();
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    }
  }
  return undefined;
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
  expect(response.status).toBe(200);
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
  test("human session and daemon summaries advertise a plain viewer link without changing JSON", async () => {
    const port = await availablePort();
    const env = {
      SENTRY_CONFIG_DIR: getConfigDir(),
      SENTRY_CLI_NO_TELEMETRY: "1",
      SENTRY_AUTH_TOKEN: "",
      SENTRY_TOKEN: "",
    };
    const created = await runCli(
      [
        "local",
        "session",
        "create",
        "viewer-link",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { env },
    );
    expect(created.exitCode, created.stderr).toBe(0);
    const { id } = JSON.parse(
      (await cli("session", "view", "viewer-link")).stdout,
    ) as { id: string };
    for (const [result, session] of [
      [created, id],
      [await runCli(["local", "session", "view", "viewer-link"], { env }), id],
      [await runCli(["local", "daemon", "status"], { env }), null],
    ] as const) {
      expect(result.exitCode, result.stderr).toBe(0);
      const link = result.stdout.match(/View events at (https:\/\/\S+)/)?.[1];
      expect(link).toBeTruthy();
      const url = new URL(link!);
      expect(url.origin).toBe("https://local.sentry.dev");
      expect(url.searchParams.get("url")).toBe(
        `http://127.0.0.1:${port}/stream`,
      );
      // Session summaries name their session; the link never carries a capability.
      expect(url.searchParams.get("session")).toBe(session);
      expect(link).not.toContain("cap");
    }
    const json = await cli("session", "view", "viewer-link");
    expect(json.stdout).not.toContain("View events at");
    expect(JSON.parse(json.stdout).label).toBe("viewer-link");
  }, 30_000);

  test("human list output is a table, and event view takes a unique ID prefix", async () => {
    const env = {
      SENTRY_CONFIG_DIR: getConfigDir(),
      SENTRY_CLI_NO_TELEMETRY: "1",
      SENTRY_AUTH_TOKEN: "",
      SENTRY_TOKEN: "",
    };
    const session = await createSession("lists", await availablePort());
    const first = `c0ffee00${"1".repeat(24)}`;
    const second = `c0ffee00${"2".repeat(24)}`;
    await ingest(session, first, "first listed event");
    await ingest(session, second, "second listed event");

    for (const command of ["session", "event", "envelope"]) {
      const human = await runCli(
        ["local", command, "list", ...(command === "session" ? [] : ["lists"])],
        { env },
      );
      expect(human.exitCode, human.stderr).toBe(0);
      expect(human.stdout).toMatch(/│ ID +│/);
      expect(human.stdout).not.toContain("{");
    }
    const events = await runCli(["local", "event", "list", "lists"], { env });
    expect(events.stdout).toContain("c0ffee001");
    expect(events.stdout).toContain("first listed event");
    const json = JSON.parse((await cli("event", "list", "lists")).stdout) as {
      events: { eventId: string }[];
    };
    expect(json.events.map(({ eventId }) => eventId).sort()).toEqual([
      first,
      second,
    ]);

    const viewed = await cli("event", "view", "lists", "c0ffee001");
    expect(viewed.exitCode, viewed.stderr).toBe(0);
    expect(JSON.parse(viewed.stdout)).toMatchObject({ eventId: first });
    const ambiguous = await cli("event", "view", "lists", "c0ffee00");
    expect(ambiguous.exitCode).toBe(23);
    expect(ambiguous.stderr).toContain(
      'Local event ID "c0ffee00" matches more than one event in session "lists".',
    );
  }, 30_000);

  test("hosted session discovery switches isolated streams and preserves retained sessions", async () => {
    const port = await availablePort();
    const web = await createSession("web", port);
    const worker = await createSession("worker", port);
    await ingest(web, "web-id", "web-only");
    await ingest(worker, "worker-id", "worker-only");
    const origin = { Origin: "https://local.sentry.dev" };
    // A user only needs the daemon address; /stream supplies discovery metadata.
    const bootstrap = await fetch(`http://127.0.0.1:${port}/stream`, {
      headers: origin,
      signal: AbortSignal.timeout(5000),
    });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://local.sentry.dev",
    );
    const bootstrapReader = bootstrap.body!.getReader();
    let directoryUrl: string;
    try {
      let text = "";
      while (!text.includes("\n\n")) {
        const chunk = await bootstrapReader.read();
        if (chunk.done) throw new Error("Bootstrap stream closed");
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain("event: sentry.local.directory");
      directoryUrl = (
        JSON.parse(at(text.match(/data: (.+)/)!, 1)) as { directoryUrl: string }
      ).directoryUrl;
    } finally {
      await bootstrapReader.cancel();
    }
    expect(directoryUrl).toBe(web.directoryUrl);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/stream`, {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const bootstrapPreflight = await fetch(`http://127.0.0.1:${port}/stream`, {
      method: "OPTIONS",
      headers: {
        ...origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(bootstrapPreflight.status).toBe(204);
    expect(
      bootstrapPreflight.headers.get("Access-Control-Allow-Private-Network"),
    ).toBe("true");
    const response = await fetch(directoryUrl, { headers: origin });
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
    ] as const) {
      const session = directory.sessions.find((s) => s.id === id)!;
      const stream = await fetch(session.streamUrl, {
        headers: origin,
        signal: AbortSignal.timeout(5000),
      });
      const reader = stream.body!.getReader();
      try {
        let text = "";
        while (!text.includes(expected)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Stream closed");
          text += new TextDecoder().decode(chunk.value);
        }
        expect(text).not.toContain(excluded);
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

  test("close freezes capture and reconnect replays a finite archive until reset", async () => {
    const session = await createSession("archive", await availablePort());
    await ingest(session, "saved-id", "saved-before-close");
    expect((await cli("session", "close", session.id)).exitCode).toBe(0);
    const rejected = await fetch(session.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: '{}\n{"type":"event"}\n{"message":"must-not-arrive"}',
    });
    expect(rejected.status).toBe(410);
    for (let attempt = 0; attempt < 2; attempt++) {
      const archive = await fetch(session.streamUrl, {
        signal: AbortSignal.timeout(5000),
      });
      const text = await archive.text();
      expect(text).toContain("saved-before-close");
      expect(text).toContain("event: sentry.local.session");
      expect(text).toContain('"state":"retained"');
      expect(text).not.toContain("must-not-arrive");
    }
    const reset = new URL(session.streamUrl);
    reset.pathname = reset.pathname.replace(/\/stream$/, "/ui/reset");
    expect((await fetch(reset, { method: "POST" })).status).toBe(204);
    const empty = await (
      await fetch(session.streamUrl, { signal: AbortSignal.timeout(5000) })
    ).text();
    expect(empty).toContain('"state":"retained"');
    expect(empty).not.toContain("saved-before-close");
    const directory = (await (await fetch(session.directoryUrl)).json()) as {
      sessions: { id: string; state: string }[];
    };
    expect(
      directory.sessions.find((entry) => entry.id === session.id)?.state,
    ).toBe("retained");
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
            expect(JSON.parse(result.stdout)).toEqual({
              stopped: true,
              capturingSessions: [],
            });
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

  test("resolves a reused session name to its newest open session through the CLI", async () => {
    const port = await availablePort();
    const first = await createSession("duplicate", port);
    const second = await createSession("duplicate", port);
    for (const parts of [
      ["session", "view"],
      ["event", "list"],
      ["envelope", "list"],
    ]) {
      const result = await cli(...parts, "duplicate");
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        `2 open sessions share that name; using the newest, ${second.id}.`,
      );
      expect(result.stderr).toContain(`${first.id} (open, started`);
      if (parts[0] === "session")
        expect(JSON.parse(result.stdout)).toMatchObject({ id: second.id });
    }

    const refused = await cli("session", "close", "duplicate");
    expect(refused.exitCode).toBe(23);
    expect(refused.stderr).toContain(
      'Local session name "duplicate" matches more than one session.',
    );
    expect(refused.stderr).toContain(
      `Use session ID ${first.id} (open, started`,
    );
    const closed = await cli("session", "close", second.id);
    expect(closed.exitCode, closed.stderr).toBe(0);
    const remaining = await cli("session", "view", "duplicate");
    expect(remaining.exitCode, remaining.stderr).toBe(0);
    expect(remaining.stderr).not.toContain("share that name");
    expect(JSON.parse(remaining.stdout)).toMatchObject({
      id: first.id,
      state: "open",
    });
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
    let replay = "";
    while (!replay.includes("web event")) {
      const chunk = await reader!.read();
      if (chunk.done) throw new Error("Stream ended before retained event");
      replay += new TextDecoder().decode(chunk.value);
    }
    expect(replay).toContain("web event");
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
          Origin: "https://local.sentry.dev",
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
      expect(response.status).toBe(200);
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
    const envelopeId = must(events[0]?.envelopeId, "a listed envelope");
    for (const parts of [["My App"], ["My", "App"]]) {
      const event = await cli("event", "view", ...parts, eventId);
      expect(event.exitCode, event.stderr).toBe(0);
      expect(event.stdout).toContain("multi-word session event");
      const raw = await cli("envelope", "view", ...parts, envelopeId);
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
      .then(async r => {const b = await r.json(); if (r.status !== 200 || b.id !== '${"c".repeat(32)}') process.exitCode=3; console.error('app completed');})
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

  test("joins an open session and hands an app without Spotlight support its DSN", async () => {
    const port = await availablePort();
    const session = await createSession("shared", port);
    // A stand-in for a Go app, whose SDK reads only SENTRY_DSN.
    const app = join(getConfigDir(), "go-app.cjs");
    await writeFile(
      app,
      `const dsn = new URL(process.env.SENTRY_DSN);
const path = dsn.pathname.replace(/\\/0$/, "");
fetch(dsn.origin + path + "/api/0/envelope/", {
  method: "POST",
  headers: { "Content-Type": "application/x-sentry-envelope" },
  body: '{"event_id":"${"d".repeat(32)}"}\\n{"type":"event"}\\n{"message":"dsn only app"}',
}).then((r) => { if (r.status !== 200) process.exitCode = 3; });
`,
    );
    let go = join(getConfigDir(), "go");
    if (process.platform === "win32") {
      go = `${go}.cmd`;
      await writeFile(go, `@"${process.execPath}" "${app}" %*\r\n`);
    } else {
      await writeFile(
        go,
        `#!/bin/sh\nexec "${process.execPath}" "${app}" "$@"\n`,
      );
      await chmod(go, 0o755);
    }
    const result = await runCli(
      [
        "local",
        "run",
        "--session",
        "shared",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--",
        go,
        "run",
        ".",
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
    expect(result.stderr).toContain(
      `Joining open session shared (${session.id})`,
    );
    expect(result.stderr).toContain(
      "SENTRY_SPOTLIGHT and SENTRY_DSN configured",
    );
    // The run joined the session `session create` made, so it stays open.
    expect(JSON.parse((await cli("session", "list")).stdout)).toMatchObject({
      sessions: [{ id: session.id, label: "shared", state: "open" }],
    });
    expect(
      (await cli("event", "view", "shared", "d".repeat(32))).stdout,
    ).toContain("dsn only app");
  }, 30_000);

  test("leaves no session behind when the app cannot start", async () => {
    const result = await runCli(
      [
        "local",
        "run",
        "--session",
        "broken",
        "--host",
        "127.0.0.1",
        "--port",
        String(await availablePort()),
        "--",
        join(getConfigDir(), "missing-program"),
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
    expect(JSON.parse((await cli("session", "list")).stdout)).toEqual({
      sessions: [],
    });
  }, 30_000);

  test("a killed run does not hold its session open for later runs", async () => {
    const dir = getConfigDir();
    const pidFile = join(dir, "held-app.pid");
    const script = join(dir, "held-app.cjs");
    await writeFile(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    const port = await availablePort();
    const { getCliCommand } = await import("../fixture.js");
    const [executable, ...prefix] = getCliCommand();
    if (!executable) throw new Error("Missing CLI executable");
    const run = spawn(
      executable,
      [
        ...prefix,
        "local",
        "run",
        "--session",
        "held",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--",
        process.execPath,
        script,
      ],
      {
        cwd: join(import.meta.dirname, "../.."),
        detached: true,
        env: {
          ...process.env,
          SENTRY_CONFIG_DIR: dir,
          SENTRY_CLI_NO_TELEMETRY: "1",
          SENTRY_AUTH_TOKEN: "",
          SENTRY_TOKEN: "",
        },
        stdio: "ignore",
      },
    );
    const closed = new Promise((resolve) => run.once("close", resolve));
    const sessions = async () =>
      (
        JSON.parse((await cli("session", "list")).stdout) as {
          sessions: { id: string; label: string; state: string }[];
        }
      ).sessions.filter((session) => session.label === "held");
    try {
      await expect
        .poll(() => readFile(pidFile, "utf8").catch(() => ""), {
          timeout: 15_000,
        })
        .not.toBe("");
      const [held] = await sessions();
      expect(held).toMatchObject({ state: "open" });
      // Like a closed terminal tab or an OOM kill: the run gets no chance to
      // release its session. Only the CLI's own pid is signalled.
      run.kill("SIGKILL");
      await closed;
      // The daemon waits a short grace for the run's stream to reconnect.
      await expect
        .poll(async () => (await sessions()).map((session) => session.state), {
          interval: 1000,
          timeout: 30_000,
        })
        .toEqual(["retained"]);
    } finally {
      run.kill("SIGKILL");
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The app already exited.
        }
      }
    }
  }, 60_000);

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
        Sentry.init({tracesSampleRate: 1});
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
    const server = createSilentServer();
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
    const server = createSilentServer();
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
      expect(result.stderr).toContain(`Port ${address.port} is already in use`);
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

  test("stop names the sessions still capturing, and their run stops waiting for the daemon", async () => {
    const { spawn } = await import("node:child_process");
    const { getCliCommand } = await import("../fixture.js");
    const dir = getConfigDir();
    const ready = join(dir, "app-ready");
    const script = join(dir, "long-app.cjs");
    // Ends by itself so a run that the test kills never leaves it behind.
    await writeFile(
      script,
      `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "");
setTimeout(() => {}, 20000);`,
    );
    const [executable, ...prefix] = getCliCommand();
    if (!executable) throw new Error("Missing CLI executable");
    const run = spawn(
      executable,
      [
        ...prefix,
        "local",
        "run",
        "--session",
        "capturing",
        "--host",
        "127.0.0.1",
        "--port",
        String(await availablePort()),
        "--",
        process.execPath,
        script,
      ],
      {
        cwd: join(import.meta.dirname, "../.."),
        env: {
          ...process.env,
          SENTRY_CONFIG_DIR: dir,
          SENTRY_CLI_NO_TELEMETRY: "1",
          SENTRY_AUTH_TOKEN: "",
          SENTRY_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    run.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    run.stdout.resume();
    const closed = new Promise<void>((resolve, reject) => {
      run.once("close", () => resolve());
      run.once("error", reject);
    });
    try {
      await expect
        .poll(() => stat(ready).then(Boolean, () => false), {
          timeout: 15_000,
        })
        .toBe(true);
      const stopped = await cli("daemon", "stop");
      expect(stopped.exitCode, stopped.stderr).toBe(0);
      expect(JSON.parse(stopped.stdout)).toMatchObject({
        stopped: true,
        capturingSessions: [{ label: "capturing" }],
      });
      expect(stopped.stderr).toContain("1 session was still capturing");
      await expect
        .poll(() => stderr, { timeout: 10_000 })
        .toContain(
          "The Local daemon stopped or restarted, so this session is no longer capturing",
        );
      // The app keeps running; only the event tail stops.
      expect(run.exitCode, stderr).toBeNull();
      expect(stderr).not.toContain("reconnecting in 2s");
    } finally {
      run.kill("SIGTERM");
      await closed;
    }
  }, 30_000);

  test("restarts on the configured port and preserves singleton discovery", async () => {
    const port = await availablePort();
    const session = await createSession("restart", port);
    const result = await cli("daemon", "restart");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      `Restarted the Local daemon while 1 session was still capturing: restart (${session.id})`,
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      host: "127.0.0.1",
      port,
    });
    await sleep(100);
    expect((await cli("daemon", "status")).exitCode).toBe(0);
  }, 30_000);
});

describe("Local foreground commands", () => {
  /** `local run` on 127.0.0.1:`port` with a child that prints a marker. */
  async function runMarkerApp(port: number) {
    return await runCli(
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
        'console.log("child-ran")',
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
  }

  test("run --port 0 binds an OS-assigned port and runs the app", async () => {
    const result = await runMarkerApp(0);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("child-ran");
  }, 30000);

  test("run binds a free port that fetch refuses to dial", async () => {
    const port = await freeFetchBlockedPort();
    if (port === undefined) return;
    const result = await runMarkerApp(port);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("child-ran");
  }, 30000);

  test("run rejects a held port that fetch refuses to dial", async () => {
    const port = await freeFetchBlockedPort();
    if (port === undefined) return;
    const holder = createSilentServer();
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(port, "127.0.0.1", resolve);
    });
    try {
      const result = await runMarkerApp(port);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("child-ran");
      expect(result.stderr).toContain(`Port ${port} is already in use`);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  }, 30000);

  test.each(["bin", "node_modules/.bin"])(
    "runs a batch-file command from %s on PATH with its arguments intact",
    async (binPath) => {
      // CLI-3T4: on Windows `print-args` is a .cmd file found by bare name,
      // where spawn alone fails with ENOENT (no PATHEXT) or EINVAL
      // (CVE-2024-27980). The arguments must reach the program unchanged and
      // none of them may run as a cmd.exe command (BatBadBut).
      const dir = getConfigDir();
      const binDir = join(dir, ...binPath.split("/"));
      await mkdir(binDir, { recursive: true });
      const printArgs = join(dir, "print-args.cjs");
      await writeFile(
        printArgs,
        "console.log(JSON.stringify(process.argv.slice(2)));",
      );
      const command = join(binDir, "print-args");
      if (process.platform === "win32") {
        await writeFile(
          `${command}.cmd`,
          `@"${process.execPath}" "${printArgs}" %*\r\n`,
        );
      } else {
        await writeFile(
          command,
          `#!/bin/sh\nexec "${process.execPath}" "${printArgs}" "$@"\n`,
        );
        await chmod(command, 0o755);
      }
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
        "PATH";
      const args = [
        "a b",
        "x&y",
        'say "hi"',
        'say "a&b"',
        'x"&echo INJECTED&"',
        "100%",
        "%PATH%",
        "a^b",
      ];
      const result = await runCli(
        [
          "local",
          "run",
          "--host",
          "127.0.0.1",
          "--port",
          String(await availablePort()),
          "--",
          "print-args",
          ...args,
        ],
        {
          env: {
            SENTRY_CONFIG_DIR: dir,
            SENTRY_CLI_NO_TELEMETRY: "1",
            [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ""}`,
          },
        },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(JSON.stringify(args));
      const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
      expect(lines.map((line) => line.trim())).not.toContain("INJECTED");
    },
    30000,
  );

  /**
   * An app that counts its SIGINTs in `count` and writes its pid next to it,
   * then dies from SIGINT half a second after the first one, which leaves
   * time for a duplicate to arrive.
   */
  async function sigintCountingApp() {
    const dir = getConfigDir();
    const count = join(dir, "sigint-count");
    const pidFile = join(dir, "sigint-app.pid");
    const script = join(dir, "sigint-app.cjs");
    await writeFile(
      script,
      `const fs = require("node:fs");
let n = 0;
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(count)}, "0");
process.on("SIGINT", () => {
  fs.writeFileSync(${JSON.stringify(count)}, String(++n));
  if (n === 1) setTimeout(() => { process.removeAllListeners("SIGINT"); process.kill(process.pid, "SIGINT"); }, 500);
});
setInterval(() => {}, 1000);
`,
    );
    const { getCliCommand } = await import("../fixture.js");
    const command = [
      ...getCliCommand(),
      "local",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      String(await availablePort()),
      "--",
      process.execPath,
      script,
    ];
    const env = {
      ...process.env,
      SENTRY_CONFIG_DIR: dir,
      SENTRY_CLI_NO_TELEMETRY: "1",
    };
    /** Kill the app if it outlived the CLI, and say whether it had. */
    const killOrphan = async () => {
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (pid <= 0) return false;
      try {
        process.kill(pid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    };
    return { command, env, count, killOrphan };
  }

  test.skipIf(process.platform === "win32")(
    "passes a SIGINT sent only to the CLI on to the app once and exits like the app",
    async () => {
      const app = await sigintCountingApp();
      const [executable, ...args] = app.command;
      if (!executable) throw new Error("Missing CLI executable");
      // Detached: its own session with no terminal, so a Ctrl-C in the
      // terminal running the tests can't reach the app.
      const cli = spawn(executable, args, {
        cwd: join(import.meta.dirname, "../.."),
        detached: true,
        env: app.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      cli.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      cli.stdout.resume();
      const closed = new Promise<number | null>((resolve, reject) => {
        cli.once("close", (code) => resolve(code));
        cli.once("error", reject);
      });
      try {
        await expect
          .poll(() => readFile(app.count, "utf8").catch(() => ""), {
            timeout: 15000,
          })
          .toBe("0");
        // Only the CLI's own pid, never its process group.
        cli.kill("SIGINT");
        expect(await closed, stderr).toBe(130);
        expect(await readFile(app.count, "utf8")).toBe("1");
        expect(stderr).not.toContain("Error:");
      } finally {
        cli.kill("SIGKILL");
        await app.killOrphan();
      }
    },
    30000,
  );

  // On a terminal the app is in the foreground process group with the CLI,
  // so Ctrl-C reaches both, while `kill -INT <cli pid>` reaches only the CLI.
  const hasPython =
    process.platform !== "win32" &&
    spawnSync("python3", ["--version"]).status === 0;
  test.skipIf(!hasPython).each([
    ["Ctrl-C in the terminal", "ctrl-c"],
    ["a SIGINT sent only to the CLI", "kill"],
  ])(
    "on a terminal, %s stops the app with one SIGINT",
    async (_name, mode) => {
      const app = await sigintCountingApp();
      let stdout: string;
      let orphaned: boolean;
      try {
        ({ stdout } = await promisify(execFile)(
          "python3",
          [
            join(import.meta.dirname, "../fixtures/pty-interrupt.py"),
            app.count,
            mode,
            ...app.command,
          ],
          { cwd: join(import.meta.dirname, "../.."), env: app.env },
        ));
      } finally {
        orphaned = await app.killOrphan();
      }
      expect(orphaned, "the app outlived the CLI").toBe(false);
      expect(JSON.parse(stdout)).toEqual({ exitCode: 130 });
      expect(await readFile(app.count, "utf8")).toBe("1");
    },
    60000,
  );

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
