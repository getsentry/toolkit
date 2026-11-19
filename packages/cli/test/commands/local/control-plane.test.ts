import { request } from "node:http";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { createLocalControlPlane } from "../../../src/commands/local/control-plane.js";
import { tryListen } from "../../../src/commands/local/server.js";
import {
  createLocalSessionStore,
  SESSION_CHOICE_HEADER,
  SESSION_RETENTION_MS,
} from "../../../src/commands/local/session-store.js";
import { at } from "../../helpers.js";

const CONTROL_TOKEN = "control-token";

function controlHeaders() {
  return { Authorization: `Bearer ${CONTROL_TOKEN}` };
}

describe("Local control plane", () => {
  test("rejects foreign request authorities before exposing daemon discovery", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    plane.sessionStore.create({ label: "private", cwd: "/private" });
    for (const url of [
      "http://attacker.example:8969/stream",
      "http://attacker.example:8969/health",
    ]) {
      const response = await plane.app.request(url);
      await response.body?.cancel();
      expect(response.status).toBe(403);
    }
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      const response = await plane.app.request(
        `http://${hostname}:8969/stream`,
        {
          headers: { Origin: "https://local.sentry.dev" },
        },
      );
      await response.body?.cancel();
      expect(response.status).toBe(200);
    }
  });

  test("rejects a foreign Host even when an absolute request target is loopback", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const listening = await tryListen(plane.app, 0, "127.0.0.1");
    try {
      for (const path of [
        "/stream",
        `http://127.0.0.1:${listening.port}/stream`,
      ]) {
        const status = await new Promise<number>((resolve, reject) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port: listening.port,
              path,
              headers: { Host: `attacker.example:${listening.port}` },
            },
            (response) => {
              resolve(response.statusCode ?? 0);
              response.destroy();
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect(status).toBe(403);
      }
    } finally {
      listening.server.closeAllConnections();
      await new Promise<void>((resolve) =>
        listening.server.close(() => resolve()),
      );
    }
  });

  test("a plain stream bootstraps discovery for trusted viewers without a control token", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({ label: "web", cwd: "/web" });
    const controller = new AbortController();
    // The daemon may advertise localhost while the user connects via 127.0.0.1.
    const response = await plane.app.request("http://127.0.0.1:8969/stream", {
      headers: { Origin: "https://local.sentry.dev" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://local.sentry.dev",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const reader = response.body!.getReader();
    try {
      const chunk = new TextDecoder().decode((await reader.read()).value);
      expect(chunk).toContain("event: sentry.local.directory");
      const data = JSON.parse(at(chunk.match(/data: (.+)/)!, 1));
      expect(new URL(data.directoryUrl).pathname).toBe(
        "/_local/v1/ui/sessions",
      );
      expect(new URL(data.directoryUrl).origin).toBe("http://127.0.0.1:8969");
      const listing = await plane.app.request(data.directoryUrl);
      expect(listing.status).toBe(200);
      const directory = await listing.json();
      expect(directory.sessions[0].id).toBe(session.id);
      expect(new URL(directory.sessions[0].streamUrl).origin).toBe(
        "http://127.0.0.1:8969",
      );
      expect(chunk).not.toContain(CONTROL_TOKEN);
    } finally {
      controller.abort();
      await reader.cancel();
    }
    for (const headers of [
      { Origin: "https://evil.example" },
      { Origin: "http://local.sentry.dev.evil.example" },
    ])
      expect((await plane.app.request("/stream", { headers })).status).toBe(
        403,
      );
    expect(
      (await plane.app.request("/stream", { method: "POST" })).status,
    ).toBe(403);
    const preflight = await plane.app.request("/stream", {
      method: "OPTIONS",
      headers: {
        Origin: "https://local.sentry.dev",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe(
      "true",
    );
  });
  test("discovers sibling streams only with the explicit browser directory capability", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const create = async (label: string) =>
      await (
        await plane.app.request("/_local/v1/sessions", {
          method: "POST",
          headers: controlHeaders(),
          body: JSON.stringify({ label, cwd: `/${label}` }),
        })
      ).json();
    const web = await create("web");
    const worker = await create("worker");
    expect(web.directoryUrl).toEqual(expect.any(String));
    const directoryCap = new URL(web.directoryUrl).searchParams.get("cap");
    expect(
      (
        await plane.app.request("/_local/v1/sessions", {
          headers: { Authorization: `Bearer ${directoryCap}` },
        })
      ).status,
    ).toBe(401);
    for (const cap of [
      "",
      CONTROL_TOKEN,
      new URL(web.streamUrl).searchParams.get("cap")!,
      new URL(web.ingestUrl).pathname.split("/").at(-1)!,
    ]) {
      const url = new URL(web.directoryUrl);
      url.searchParams.set("cap", cap);
      expect((await plane.app.request(url.toString())).status).toBe(401);
    }
    const response = await plane.app.request(web.directoryUrl, {
      headers: { Origin: "https://local.sentry.dev" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://local.sentry.dev",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: web.id,
          label: "web",
          state: "open",
          streamUrl: web.streamUrl,
        }),
        expect.objectContaining({
          id: worker.id,
          label: "worker",
          state: "open",
          streamUrl: worker.streamUrl,
        }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain("ingestUrl");
    expect(JSON.stringify(body)).not.toContain(CONTROL_TOKEN);
    expect(
      (
        await plane.app.request(web.directoryUrl, {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const preflight = await plane.app.request(web.directoryUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "https://local.sentry.dev",
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
        await plane.app.request(web.directoryUrl, {
          method: "POST",
          headers: { Origin: "https://local.sentry.dev" },
        })
      ).status,
    ).toBe(403);
    const closed = plane.sessionStore.close(worker.id);
    expect(
      (await (await plane.app.request(web.directoryUrl)).json()).sessions,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: worker.id,
          state: "retained",
          expiresAt: closed.expiresAt,
        }),
      ]),
    );
  });

  test("replaces expired clientId sessions with usable fresh capabilities on creation", async () => {
    let now = 1000;
    const sessionStore = createLocalSessionStore({ now: () => now });
    const plane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
      sessionStore,
    });
    const create = () =>
      plane.app.request("/_local/v1/sessions", {
        method: "POST",
        headers: controlHeaders(),
        body: JSON.stringify({
          clientId: "retry-key",
          label: "web",
          cwd: "/web",
        }),
      });
    const first = await (await create()).json();
    sessionStore.close(first.id);
    now += SESSION_RETENTION_MS - 1;
    expect(await (await create()).json()).toMatchObject({
      id: first.id,
      state: "retained",
    });
    now += 1;
    const response = await create();
    expect(response.status).toBe(201);
    const replacement = await response.json();
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.state).toBe("open");
    expect(replacement.ingestUrl).not.toBe(first.ingestUrl);
    expect(replacement.streamUrl).not.toBe(first.streamUrl);
    const ingested = await plane.app.request(replacement.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: '{}\n{"type":"event"}\n{"event_id":"fresh","message":"fresh capture"}',
    });
    expect(ingested.status).toBe(204);
    expect(
      sessionStore.getBuffer(replacement.id).read({ all: true }),
    ).toHaveLength(1);
    expect(
      (
        await plane.app.request(`/_local/v1/sessions/${replacement.id}`, {
          headers: controlHeaders(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await plane.app.request(`/_local/v1/sessions/${first.id}`, {
          headers: controlHeaders(),
        })
      ).status,
    ).toBe(404);
    expect(sessionStore.list()).toHaveLength(1);
  });

  test("close and finite replay advertise the original saved deadline after reset", async () => {
    let now = 1000;
    const sessionStore = createLocalSessionStore({ now: () => now });
    const plane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
      sessionStore,
    });
    const session = await (
      await plane.app.request("/_local/v1/sessions", {
        method: "POST",
        headers: controlHeaders(),
        body: JSON.stringify({ label: "web", cwd: "/web" }),
      })
    ).json();
    const live = await plane.app.request(session.streamUrl);
    const reading = live.text();
    const closed = sessionStore.close(session.id);
    const metadata = JSON.stringify({
      state: "retained",
      expiresAt: closed.expiresAt,
    });
    expect(await reading).toContain(metadata);
    now += 60_000;
    expect(await (await plane.app.request(session.streamUrl)).text()).toContain(
      metadata,
    );
    sessionStore.reset(session.id);
    expect(await (await plane.app.request(session.streamUrl)).text()).toContain(
      metadata,
    );
    expect(sessionStore.resolve(session.id).expiresAt).toBe(
      1000 + SESSION_RETENTION_MS,
    );
  });

  test("validates retention settings and rejects untrusted scoped mutations", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const created = await plane.app.request("/_local/v1/sessions", {
      method: "POST",
      headers: controlHeaders(),
      body: JSON.stringify({ label: "web", cwd: "/web", maxEnvelopes: 1000 }),
    });
    const session = await created.json();
    expect(session.maxEnvelopes).toBe(1000);
    const path = `/_local/v1/sessions/${session.id}/ui/retention?cap=${plane.sessionStore.getCapabilities(session.id).stream}`;
    for (const origin of ["https://example.com"]) {
      const result = await plane.app.request(path, {
        method: "POST",
        headers: { Origin: origin },
        body: JSON.stringify({ maxEnvelopes: 2000 }),
      });
      expect(result.status).toBe(403);
    }
    const result = await plane.app.request(path, {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
      body: JSON.stringify({ maxEnvelopes: 2000 }),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ maxEnvelopes: 2000 });
    const invalid = await plane.app.request(path, {
      method: "POST",
      body: JSON.stringify({ maxEnvelopes: 0 }),
    });
    expect(invalid.status).toBe(400);
    expect(plane.sessionStore.resolve(session.id).maxEnvelopes).toBe(2000);
  });

  test("trusted hosted viewers can update only scoped retention with a valid capability", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({ label: "web", cwd: "/web" });
    const cap = plane.sessionStore.getCapabilities(session.id).stream;
    const base = `/_local/v1/sessions/${session.id}/ui`;
    for (const origin of [
      "https://local.sentry.dev",
      "https://sentry-local-git-codex-local-session-switcher.sentry.dev",
    ]) {
      const path = `${base}/retention?cap=${cap}`;
      const preflight = await plane.app.request(path, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
          "Access-Control-Request-Private-Network": "true",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(
        preflight.headers.get("Access-Control-Allow-Private-Network"),
      ).toBe("true");
      const update = await plane.app.request(path, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: '{"maxEnvelopes":50000}',
      });
      expect(update.status).toBe(200);
      expect(update.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(await update.json()).toMatchObject({ maxEnvelopes: 50000 });
      expect(
        (
          await plane.app.request(`${base}/retention?cap=wrong`, {
            method: "POST",
            headers: { Origin: origin },
            body: '{"maxEnvelopes":1000}',
          })
        ).status,
      ).toBe(401);
      for (const action of ["reset", "close"]) {
        expect(
          (
            await plane.app.request(`${base}/${action}?cap=${cap}`, {
              method: "POST",
              headers: { Origin: origin },
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await plane.app.request(`${base}/${action}?cap=${cap}`, {
              method: "OPTIONS",
              headers: {
                Origin: origin,
                "Access-Control-Request-Method": "POST",
              },
            })
          ).status,
        ).toBe(403);
      }
    }
    for (const origin of [
      "https://evil.example",
      "https://local.sentry.dev.evil.example",
      "http://local.sentry.dev",
    ]) {
      expect(
        (
          await plane.app.request(`${base}/retention?cap=${cap}`, {
            method: "POST",
            headers: { Origin: origin },
            body: '{"maxEnvelopes":1000}',
          })
        ).status,
      ).toBe(403);
    }
    for (const value of [-1, 0, 1.5, 50001, "1000", null]) {
      const result = await plane.app.request(`${base}/retention?cap=${cap}`, {
        method: "POST",
        headers: { Origin: "https://local.sentry.dev" },
        body: JSON.stringify({ maxEnvelopes: value }),
      });
      expect(result.status).toBe(400);
    }
    expect(plane.sessionStore.resolve(session.id).maxEnvelopes).toBe(50000);
  });

  test("resolves a shared session name to its newest open session on every control route", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const older = plane.sessionStore.create({ label: "My App", cwd: "/one" });
    const newer = plane.sessionStore.create({ label: "My App", cwd: "/two" });
    const closed = plane.sessionStore.create({
      label: "My App",
      cwd: "/three",
    });
    plane.sessionStore.close(closed.id);
    for (const [method, suffix] of [
      ["GET", ""],
      ["GET", "/events"],
      ["GET", "/envelopes"],
      ["GET", "/retention"],
    ] as const) {
      const response = await plane.app.request(
        `/_local/v1/sessions/My%20App${suffix}`,
        { method, headers: controlHeaders() },
      );
      expect(response.status, suffix).toBeLessThan(300);
      expect(
        JSON.parse(response.headers.get(SESSION_CHOICE_HEADER) ?? "null"),
      ).toEqual({
        id: newer.id,
        others: [{ id: older.id, createdAt: older.createdAt }],
      });
    }
    const viewed = await plane.app.request("/_local/v1/sessions/My%20App", {
      headers: controlHeaders(),
    });
    await expect(viewed.json()).resolves.toMatchObject({ id: newer.id });
    const byId = await plane.app.request(`/_local/v1/sessions/${older.id}`, {
      headers: controlHeaders(),
    });
    expect(byId.status).toBe(200);
    expect(byId.headers.get(SESSION_CHOICE_HEADER)).toBeNull();
    expect(
      (
        await plane.app.request("/_local/v1/sessions/missing", {
          headers: controlHeaders(),
        })
      ).status,
    ).toBe(404);

    plane.sessionStore.close(newer.id);
    const remaining = await plane.app.request("/_local/v1/sessions/My%20App", {
      headers: controlHeaders(),
    });
    expect(remaining.headers.get(SESSION_CHOICE_HEADER)).toBeNull();
    await expect(remaining.json()).resolves.toMatchObject({
      id: older.id,
      state: "open",
    });
  });

  test("refuses to change a session by a name that several open sessions share", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const older = plane.sessionStore.create({ label: "p", cwd: "/one" });
    const newer = plane.sessionStore.create({ label: "p", cwd: "/two" });
    const { stream } = plane.sessionStore.getCapabilities(newer.id);
    for (const [suffix, body] of [
      ["/close", "{}"],
      ["/reset", "{}"],
      ["/retention", JSON.stringify({ maxEnvelopes: 10 })],
      [`/ui/close?cap=${stream}`, "{}"],
    ] as const) {
      const response = await plane.app.request(
        `/_local/v1/sessions/p${suffix}`,
        {
          method: "POST",
          headers: { ...controlHeaders(), "Content-Type": "application/json" },
          body,
        },
      );
      expect(response.status, suffix).toBe(409);
      expect(response.headers.get(SESSION_CHOICE_HEADER)).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        code: "ambiguous_session",
        reference: "p",
        sessionIds: [newer.id, older.id],
        sessions: [
          { id: newer.id, state: "open", createdAt: newer.createdAt },
          { id: older.id, state: "open", createdAt: older.createdAt },
        ],
      });
    }
    // A stream capability alone must not reveal the other sessions.
    const viewer = await plane.app.request(
      `/_local/v1/sessions/p/ui/close?cap=${stream}`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );
    expect(viewer.status).toBe(409);
    const viewerBody: Record<string, unknown> = await viewer.json();
    expect(viewerBody).toMatchObject({ code: "ambiguous_session" });
    expect(viewerBody).not.toHaveProperty("sessionIds");
    expect(viewerBody).not.toHaveProperty("sessions");
    expect(JSON.stringify(viewerBody)).not.toContain(older.id);

    expect(plane.sessionStore.resolve(newer.id)).toMatchObject({
      state: "open",
      maxEnvelopes: newer.maxEnvelopes,
    });
    expect(plane.sessionStore.resolve(older.id).state).toBe("open");

    const byId = await plane.app.request(
      `/_local/v1/sessions/${newer.id}/close`,
      {
        method: "POST",
        headers: controlHeaders(),
      },
    );
    expect(byId.status).toBe(200);
    const byName = await plane.app.request("/_local/v1/sessions/p/close", {
      method: "POST",
      headers: controlHeaders(),
    });
    await expect(byName.json()).resolves.toMatchObject({
      id: older.id,
      state: "retained",
    });
  });

  test("caps the sessions it names when many open sessions share a name", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const sessions = Array.from({ length: 300 }, () =>
      plane.sessionStore.create({ label: "busy", cwd: "/busy" }),
    );
    const response = await plane.app.request("/_local/v1/sessions/busy", {
      headers: controlHeaders(),
    });
    expect(response.status).toBe(200);
    const header = response.headers.get(SESSION_CHOICE_HEADER) ?? "";
    expect(header.length).toBeLessThan(1024);
    const choice = JSON.parse(header) as {
      id: string;
      others: { id: string }[];
      more: number;
    };
    expect(choice.id).toBe(sessions.at(-1)?.id);
    expect(choice.others).toHaveLength(5);
    expect(choice.more).toBe(294);
  });

  test("creates isolated sessions through its authenticated control API", async () => {
    const controlPlane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
    });

    const created = await controlPlane.app.request("/_local/v1/sessions", {
      method: "POST",
      headers: { ...controlHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "web", cwd: "/work/web" }),
    });

    expect(created.status).toBe(201);
    const session = (await created.json()) as {
      id: string;
      label: string;
      ingestUrl: string;
      streamUrl: string;
    };
    expect(session.label).toBe("web");
    expect(session.ingestUrl).toContain(`/${session.id}/ingest/`);
    expect(new URL(session.ingestUrl).search).toBe("");
    expect(session.streamUrl).toContain(`/${session.id}/stream?cap=`);
    expect(session.ingestUrl).not.toBe(session.streamUrl);

    const sessions = await controlPlane.app.request("/_local/v1/sessions", {
      headers: controlHeaders(),
    });
    await expect(sessions.json()).resolves.toMatchObject({
      sessions: [{ id: session.id, label: "web", state: "open" }],
    });
  });

  test("does not expose the session registry without the control capability", async () => {
    const controlPlane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
    });

    const response = await controlPlane.app.request("/_local/v1/sessions");

    expect(response.status).toBe(401);
  });

  test("accepts envelopes only through the matching session ingestion capability", async () => {
    const controlPlane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
    });
    const created = await controlPlane.app.request("/_local/v1/sessions", {
      method: "POST",
      headers: { ...controlHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "web", cwd: "/work/web" }),
    });
    const session = (await created.json()) as { id: string; ingestUrl: string };
    const envelope =
      '{"sdk":{"name":"sentry.node"}}\n{"type":"event"}\n{"message":"isolated"}';

    const ingested = await controlPlane.app.request(session.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: envelope,
    });
    expect(ingested.status).toBe(204);
    expect(
      controlPlane.sessionStore.getBuffer(session.id).read({ all: true }),
    ).toHaveLength(1);

    const rejected = await controlPlane.app.request(
      session.ingestUrl.replace(/\/ingest\/[^/]+$/, "/ingest/wrong"),
      { method: "POST", body: envelope },
    );
    expect(rejected.status).toBe(401);
  });

  test("accepts Spotlight /stream and DSN envelope posts under the ingest capability", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({ label: "php", cwd: "/work" });
    const caps = plane.sessionStore.getCapabilities(session.id);
    const ingest = `/_local/v1/sessions/${session.id}/ingest`;
    const envelope =
      '{"sdk":{"name":"sentry.php"}}\n{"type":"event"}\n{"message":"hi"}';
    const post = (path: string, headers: Record<string, string> = {}) =>
      plane.app.request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          ...headers,
        },
        body: envelope,
      });

    // PHP posts to `<SENTRY_SPOTLIGHT>/stream`; Go, Rust, PHP and Ruby build
    // `<dsn path>/api/<project>/envelope/` from a DSN.
    for (const suffix of ["/stream", "/api/0/envelope/", "/api/0/envelope"]) {
      expect((await post(`${ingest}/${caps.ingest}${suffix}`)).status).toBe(
        204,
      );
      expect((await post(`${ingest}/wrong${suffix}`)).status).toBe(401);
      expect((await post(`${ingest}/${caps.stream}${suffix}`)).status).toBe(
        401,
      );
      expect(
        (
          await post(`${ingest}/${caps.ingest}${suffix}`, {
            Origin: "https://example.com",
          })
        ).status,
      ).toBe(403);
    }
    // A path under the ingest capability can't climb to the stream-capability
    // UI actions.
    for (const dots of ["..", "%2e%2e"]) {
      expect(
        (
          await post(
            `${ingest}/${caps.ingest}/${dots}/${dots}/ui/reset?cap=${caps.ingest}`,
          )
        ).status,
      ).toBe(401);
    }
    expect(
      plane.sessionStore.getBuffer(session.id).read({ all: true }),
    ).toHaveLength(3);
  });

  test("drops the DSN, which holds the ingest capability, from session envelope headers", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({ label: "go", cwd: "/work" });
    const caps = plane.sessionStore.getCapabilities(session.id);
    const base = `http://127.0.0.1:8969/_local/v1/sessions/${session.id}`;
    const item = '{"message":"hi"}';
    const envelope = [
      JSON.stringify({
        event_id: "dsn-header",
        dsn: `http://local@127.0.0.1:8969/_local/v1/sessions/${session.id}/ingest/${caps.ingest}/0`,
        sdk: { name: "sentry.go" },
      }),
      `{"type":"event","length":${item.length}}`,
      item,
    ].join("\n");
    // PHP and Ruby compress their requests.
    for (const [body, headers] of [
      [envelope, {}],
      [gzipSync(envelope), { "Content-Encoding": "gzip" }],
    ] as const) {
      const posted = await plane.app.request(
        `${base}/ingest/${caps.ingest}/api/0/envelope/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-sentry-envelope",
            ...headers,
          },
          body,
        },
      );
      expect(posted.status).toBe(204);
    }

    const stored = plane.sessionStore
      .getBuffer(session.id)
      .read({ all: true })
      .map((container) => container.getData().toString("utf8"));
    expect(stored).toHaveLength(2);
    for (const data of stored) {
      expect(data).not.toContain(caps.ingest);
      expect(data).toContain('"event_id":"dsn-header"');
      expect(data.endsWith(`\n${item}`)).toBe(true);
    }

    const controller = new AbortController();
    const response = await plane.app.request(
      `${base}/stream?cap=${caps.stream}`,
      { signal: controller.signal },
    );
    const reader = response.body!.getReader();
    let streamed = "";
    try {
      while ((streamed.match(/dsn-header/g) ?? []).length < 2)
        streamed += new TextDecoder().decode((await reader.read()).value);
    } finally {
      controller.abort();
      await reader.cancel();
    }
    expect(streamed).not.toContain(caps.ingest);
  });

  test("protects pathname ingestion from read capabilities and remote browser writes", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({
      label: "sdk",
      cwd: "/work/sdk",
    });
    const caps = plane.sessionStore.getCapabilities(session.id);
    const path = `/_local/v1/sessions/${session.id}/ingest`;
    expect(
      (await plane.app.request(`${path}/${caps.stream}`, { method: "POST" }))
        .status,
    ).toBe(401);
    expect(
      (
        await plane.app.request(`${path}/wrong?cap=${caps.ingest}`, {
          method: "POST",
        })
      ).status,
    ).toBe(401);
    expect((await plane.app.request(`${path}/${caps.ingest}`)).status).toBe(
      401,
    );
    for (const origin of ["https://example.com"]) {
      expect(
        (
          await plane.app.request(`${path}/${caps.ingest}`, {
            method: "POST",
            headers: { Origin: origin },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await plane.app.request(`${path}/${caps.ingest}`, {
            method: "OPTIONS",
            headers: {
              Origin: origin,
              "Access-Control-Request-Method": "POST",
            },
          })
        ).status,
      ).toBe(403);
    }
    const preflight = await plane.app.request(`${path}/${caps.ingest}`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
  });

  test("rejects remote browser writes through the legacy scoped stream route", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({ label: "web", cwd: "/web" });
    const cap = plane.sessionStore.getCapabilities(session.id).ingest;
    const path = `/_local/v1/sessions/${session.id}/stream?cap=${cap}&sentry_client=sentry.javascript.browser/10.0`;
    for (const origin of ["https://example.com", "https://local.sentry.dev"]) {
      const response = await plane.app.request(path, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "text/plain" },
        body: '{"event_id":"origin-test"}\n{"type":"event"}\n{"message":"forged"}',
      });
      expect(response.status).toBe(403);
      expect(
        plane.sessionStore.getBuffer(session.id).read({ all: true }),
      ).toHaveLength(0);
      expect(
        (
          await plane.app.request(path, {
            method: "OPTIONS",
            headers: {
              Origin: origin,
              "Access-Control-Request-Method": "POST",
            },
          })
        ).status,
      ).toBe(403);
    }
  });

  test("allows subscribers only through the session stream capability", async () => {
    const controlPlane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
    });
    const created = await controlPlane.app.request("/_local/v1/sessions", {
      method: "POST",
      headers: { ...controlHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "web", cwd: "/work/web" }),
    });
    const session = (await created.json()) as { streamUrl: string };

    const rejected = await controlPlane.app.request(
      session.streamUrl.replace(/cap=[^&]+/, "cap=wrong"),
    );
    expect(rejected.status).toBe(401);

    const stream = await controlPlane.app.request(session.streamUrl);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });

  test("indexes decoded events by their Sentry event ID", async () => {
    const controlPlane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
    });
    const created = await controlPlane.app.request("/_local/v1/sessions", {
      method: "POST",
      headers: { ...controlHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "web", cwd: "/work/web" }),
    });
    const session = (await created.json()) as { id: string; ingestUrl: string };
    await controlPlane.app.request(session.ingestUrl, {
      method: "POST",
      body: '{"event_id":"event-123"}\n{"type":"event"}\n{"message":"isolated"}',
    });

    const listed = await controlPlane.app.request(
      `/_local/v1/sessions/${session.id}/events`,
      { headers: controlHeaders() },
    );
    await expect(listed.json()).resolves.toMatchObject({
      events: [{ eventId: "event-123" }],
    });
    const viewed = await controlPlane.app.request(
      `/_local/v1/sessions/${session.id}/events/event-123`,
      { headers: controlHeaders() },
    );
    expect(viewed.status).toBe(200);
  });

  test("gives each replay segment its own event ID", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({ label: "web", cwd: "/web" });
    const { ingest } = plane.sessionStore.getCapabilities(session.id);
    const replayId = "5c3b1e7a9d2f4e6a8b0c1d2e3f4a5b6c";
    // @sentry/browser sends every replay segment with the replay ID as the
    // envelope event_id.
    for (const segmentId of [0, 1]) {
      const response = await plane.app.request(
        `/_local/v1/sessions/${session.id}/ingest/${ingest}`,
        {
          method: "POST",
          body: [
            { event_id: replayId, sent_at: "2026-11-17T20:25:06.000Z" },
            { type: "replay_event" },
            {
              type: "replay_event",
              replay_id: replayId,
              event_id: replayId,
              segment_id: segmentId,
              timestamp: 1_794_947_106 + segmentId,
            },
            { type: "replay_recording", length: 2 },
            "[]",
          ]
            .map((line) =>
              typeof line === "string" ? line : JSON.stringify(line),
            )
            .join("\n"),
        },
      );
      expect(response.status).toBe(204);
    }

    const listed = await plane.app.request(
      `/_local/v1/sessions/${session.id}/events`,
      { headers: controlHeaders() },
    );
    const { events } = (await listed.json()) as {
      events: { eventId: string; envelopeId: string }[];
    };
    expect(events).toHaveLength(2);
    const ids = events.map((event) => event.eventId);
    expect(new Set(ids).size).toBe(2);
    for (const event of events) {
      const viewed = await plane.app.request(
        `/_local/v1/sessions/${session.id}/events/${encodeURIComponent(event.eventId)}`,
        { headers: controlHeaders() },
      );
      expect(viewed.status).toBe(200);
      await expect(viewed.json()).resolves.toMatchObject({
        envelopeId: event.envelopeId,
      });
    }
  });

  test("summarizes each listed event so agents can skip per-event views", async () => {
    const traceId = "4c79f60c11214eb38604f4ae0781bfb2";
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({ label: "sdk", cwd: "/sdk" });
    const { ingest } = plane.sessionStore.getCapabilities(session.id);
    const send = async (...lines: unknown[]) => {
      const response = await plane.app.request(
        `/_local/v1/sessions/${session.id}/ingest/${ingest}`,
        {
          method: "POST",
          body: lines.map((line) => JSON.stringify(line)).join("\n"),
        },
      );
      expect(response.status).toBe(204);
    };
    const before = Date.now();

    // sentry-python: logging.error("Payment failed for order %s", 42)
    await send(
      { event_id: "9ec79c33ec9942ab8353589fcb2e04dc" },
      { type: "event" },
      {
        level: "error",
        logger: "shop.payments",
        logentry: {
          message: "Payment failed for order %s",
          params: [42],
          formatted: "Payment failed for order 42",
        },
        platform: "python",
        timestamp: "2026-11-17T10:00:00.100000Z",
        contexts: { trace: { trace_id: traceId, span_id: "a7e1f3b5c9d2e4f6" } },
      },
    );
    // JavaScript SDK 11: captureMessage with a synthetic stack, no exception type
    await send(
      {
        event_id: "b1c2d3e4f5a64b7c8d9e0f1a2b3c4d5e",
        trace: { trace_id: traceId },
      },
      { type: "event" },
      {
        level: "warning",
        message: "Hello from captureMessage",
        exception: {
          values: [
            {
              value: "Hello from captureMessage",
              mechanism: { type: "generic", synthetic: true },
            },
          ],
        },
        platform: "javascript",
        timestamp: 1_794_045_602.5,
      },
    );
    // An exception thrown in a Node.js route handler
    await send(
      { event_id: "d1e2f3a4b5c64d7e8f9a0b1c2d3e4f5a" },
      { type: "event" },
      {
        level: "error",
        exception: {
          values: [{ type: "TypeError", value: "x is not a function" }],
        },
        platform: "node",
        timestamp: 1_794_045_603,
        contexts: { trace: { trace_id: traceId, span_id: "d4e5f6a7b8c9d0e1" } },
      },
    );
    await send(
      { event_id: "f1e2d3c4b5a64f7e8d9c0b1a2f3e4d5c" },
      { type: "transaction" },
      {
        transaction: "GET /api/users",
        start_timestamp: 1_794_045_603,
        timestamp: 1_794_045_604,
        contexts: { trace: { trace_id: traceId, span_id: "e5f6a7b8c9d0e1f2" } },
      },
    );
    await send(
      { sdk: { name: "sentry.python.flask" } },
      { type: "log", item_count: 2 },
      {
        items: [
          {
            timestamp: 1_794_045_605,
            trace_id: traceId,
            level: "info",
            body: '"GET /boom HTTP/1.1" 500 -',
          },
          { timestamp: 1_794_045_605.1, level: "error", body: "boom" },
        ],
      },
    );
    await send(
      { sdk: { name: "sentry.javascript.node" } },
      { type: "session" },
      {
        sid: "7c0ab2b2a4b74bb9b9b5e5c6b1d2e3f4",
        status: "exited",
        started: "2026-11-17T10:00:00.000Z",
        timestamp: "2026-11-17T10:00:06.000Z",
      },
    );

    const received = Date.now();
    const list = async () => {
      const listed = await plane.app.request(
        `/_local/v1/sessions/${session.id}/events`,
        { headers: controlHeaders() },
      );
      return ((await listed.json()) as { events: Record<string, unknown>[] })
        .events;
    };
    const events = await list();
    expect(events.map(({ receivedAt: _, ...event }) => event)).toEqual([
      {
        envelopeId: expect.any(String),
        eventId: "9ec79c33ec9942ab8353589fcb2e04dc",
        itemTypes: ["event"],
        type: "message",
        level: "error",
        title: "Payment failed for order 42",
        timestamp: "2026-11-17T10:00:00.100Z",
        traceId,
      },
      {
        envelopeId: expect.any(String),
        eventId: "b1c2d3e4f5a64b7c8d9e0f1a2b3c4d5e",
        itemTypes: ["event"],
        type: "message",
        level: "warning",
        title: "Hello from captureMessage",
        timestamp: "2026-11-07T10:00:02.500Z",
        traceId,
      },
      {
        envelopeId: expect.any(String),
        eventId: "d1e2f3a4b5c64d7e8f9a0b1c2d3e4f5a",
        itemTypes: ["event"],
        type: "error",
        level: "error",
        title: "TypeError: x is not a function",
        timestamp: "2026-11-07T10:00:03.000Z",
        traceId,
      },
      {
        envelopeId: expect.any(String),
        eventId: "f1e2d3c4b5a64f7e8d9c0b1a2f3e4d5c",
        itemTypes: ["transaction"],
        type: "transaction",
        title: "GET /api/users",
        timestamp: "2026-11-07T10:00:04.000Z",
        traceId,
      },
      {
        envelopeId: expect.any(String),
        eventId: expect.any(String),
        itemTypes: ["log"],
        type: "log",
        level: "error",
        title: "boom",
        timestamp: "2026-11-07T10:00:05.100Z",
        traceId,
        count: 2,
      },
      {
        envelopeId: expect.any(String),
        eventId: expect.any(String),
        itemTypes: ["session"],
        type: "session",
        title: "exited",
        timestamp: "2026-11-17T10:00:06.000Z",
      },
    ]);
    for (const event of events) {
      const receivedAt = Date.parse(String(event["receivedAt"]));
      expect(receivedAt).toBeGreaterThanOrEqual(before);
      expect(receivedAt).toBeLessThanOrEqual(received);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await list()).toEqual(events);

    const viewed = await plane.app.request(
      `/_local/v1/sessions/${session.id}/events/d1e2f3a4b5c64d7e8f9a0b1c2d3e4f5a`,
      { headers: controlHeaders() },
    );
    await expect(viewed.json()).resolves.toMatchObject({
      type: "error",
      title: "TypeError: x is not a function",
      receivedAt: expect.any(String),
      envelope: expect.any(Array),
    });
  });

  test.each([
    [
      { sdk: { name: "sentry.node" } },
      { type: "event", event_id: "item-id" },
      { event_id: "payload-id" },
      "item-id",
    ],
    [{}, { type: "transaction" }, { event_id: "payload-id" }, "payload-id"],
    [
      { event_id: "header-id" },
      { type: "event", event_id: "item-id" },
      { event_id: "payload-id" },
      "header-id",
    ],
  ])(
    "indexes SDK item IDs with envelope-header precedence",
    async (header, item, payload, eventId) => {
      const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
      const session = plane.sessionStore.create({ label: "sdk", cwd: "/sdk" });
      const { ingest } = plane.sessionStore.getCapabilities(session.id);
      const response = await plane.app.request(
        `/_local/v1/sessions/${session.id}/ingest/${ingest}`,
        {
          method: "POST",
          body: [header, item, payload]
            .map((value) => JSON.stringify(value))
            .join("\n"),
        },
      );
      expect(response.status).toBe(204);
      const listed = await plane.app.request(
        `/_local/v1/sessions/${session.id}/events`,
        { headers: controlHeaders() },
      );
      await expect(listed.json()).resolves.toMatchObject({
        events: [{ eventId }],
      });
      const viewed = await plane.app.request(
        `/_local/v1/sessions/${session.id}/events/${eventId}`,
        { headers: controlHeaders() },
      );
      expect(viewed.status).toBe(200);
      const data = await viewed.json();
      expect(data.envelopeId).toBeTruthy();
      const raw = await plane.app.request(
        `/_local/v1/sessions/${session.id}/envelopes/${data.envelopeId}`,
        { headers: controlHeaders() },
      );
      expect(raw.status).toBe(200);
    },
  );

  test("permits browser preflight only from a loopback development origin", async () => {
    const controlPlane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
    });
    const created = await controlPlane.app.request("/_local/v1/sessions", {
      method: "POST",
      headers: { ...controlHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "web", cwd: "/work/web" }),
    });
    const session = (await created.json()) as { ingestUrl: string };
    const response = await controlPlane.app.request(session.ingestUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
  });

  test("acknowledges a daemon stop request before closing its listener", async () => {
    let server: import("node:http").Server | undefined;
    const controlPlane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
      onStop: () => {
        server?.closeAllConnections();
        server?.close();
      },
    });
    const listening = await tryListen(controlPlane.app, 0, "127.0.0.1");
    server = listening.server;

    const statusCode = await new Promise<number>((resolve, reject) => {
      const stopRequest = request(
        `http://127.0.0.1:${listening.port}/_local/v1/daemon/stop`,
        { method: "POST", headers: controlHeaders() },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      stopRequest.on("error", reject);
      stopRequest.end();
    });
    expect(statusCode).toBe(202);
  });

  test("lets a loopback UI reset and close only its scoped session", async () => {
    const controlPlane = createLocalControlPlane({
      controlToken: CONTROL_TOKEN,
    });
    const created = await controlPlane.app.request("/_local/v1/sessions", {
      method: "POST",
      headers: { ...controlHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "web", cwd: "/work/web" }),
    });
    const session = (await created.json()) as {
      id: string;
      ingestUrl: string;
      streamUrl: string;
    };
    const resetUrl = session.streamUrl.replace(/\/stream\?/, "/ui/reset?");
    const closeUrl = session.streamUrl.replace(/\/stream\?/, "/ui/close?");
    await controlPlane.app.request(session.ingestUrl, {
      method: "POST",
      body: '{"event_id":"before-reset"}\n{"type":"event"}\n{"message":"kept private"}',
    });
    expect(
      controlPlane.sessionStore.getBuffer(session.id).read({ all: true }),
    ).toHaveLength(1);

    const preflight = await controlPlane.app.request(resetUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );

    const wrongCapability = await controlPlane.app.request(
      resetUrl.replace(/cap=[^&]+/, "cap=wrong"),
      { method: "POST", headers: { Origin: "http://localhost:5173" } },
    );
    expect(wrongCapability.status).toBe(401);

    expect(
      (
        await controlPlane.app.request(resetUrl, {
          method: "POST",
          headers: { Origin: "http://localhost:5173" },
        })
      ).status,
    ).toBe(204);
    expect(
      controlPlane.sessionStore.getBuffer(session.id).read({ all: true }),
    ).toHaveLength(0);

    const rejected = await controlPlane.app.request(closeUrl, {
      method: "POST",
      headers: { Origin: "https://receiver.example" },
    });
    expect(rejected.status).toBe(403);

    const closed = await controlPlane.app.request(closeUrl, {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(closed.status).toBe(200);
    expect(controlPlane.sessionStore.resolve(session.id).state).toBe(
      "retained",
    );
  });
});

describe("Local daemon receiver compatibility", () => {
  test.each(["gzip", "deflate", "br"] as const)(
    "decodes %s SDK envelopes",
    async (encoding) => {
      const { gzipSync, deflateSync, brotliCompressSync } =
        await import("node:zlib");
      const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
      const session = plane.sessionStore.create({
        label: "compressed",
        cwd: "/work",
      });
      const capability = plane.sessionStore.getCapabilities(session.id).ingest;
      const compress = {
        gzip: gzipSync,
        deflate: deflateSync,
        br: brotliCompressSync,
      }[encoding];
      const response = await plane.app.request(
        `/_local/v1/sessions/${session.id}/stream?cap=${capability}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-sentry-envelope",
            "Content-Encoding": encoding,
          },
          body: new Uint8Array(
            compress(
              '{"event_id":"compressed"}\n{"type":"event"}\n{"message":"compressed SDK"}',
            ),
          ),
        },
      );
      expect(response.status).toBe(204);
      const events = await plane.app.request(
        `/_local/v1/sessions/${session.id}/events/compressed`,
        { headers: controlHeaders() },
      );
      expect(events.status).toBe(200);
      expect(await events.text()).toContain("compressed SDK");
    },
  );

  test("supports sendBeacon browser SDK envelopes", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({
      label: "browser",
      cwd: "/work",
    });
    const cap = plane.sessionStore.getCapabilities(session.id).ingest;
    const ingested = await plane.app.request(
      `/_local/v1/sessions/${session.id}/stream?cap=${cap}&sentry_client=sentry.javascript.browser/10.0`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Origin: "http://localhost:3000",
        },
        body: '{"event_id":"browser"}\n{"type":"event"}\n{"message":"browser SDK"}',
      },
    );
    expect(ingested.status).toBe(204);
    const response = await plane.app.request(
      `/_local/v1/sessions/${session.id}/events/browser`,
      { headers: controlHeaders() },
    );
    expect(response.status).toBe(200);
  });

  test("allows hosted viewer reads and private-network preflight while rejecting hosted mutations", async () => {
    const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
    const session = plane.sessionStore.create({
      label: "hosted",
      cwd: "/work",
    });
    const cap = plane.sessionStore.getCapabilities(session.id).stream;
    const path = `/_local/v1/sessions/${session.id}/stream?cap=${cap}`;
    const preflight = await plane.app.request(path, {
      method: "OPTIONS",
      headers: {
        Origin: "https://local.sentry.dev",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Last-Event-ID",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://local.sentry.dev",
    );
    expect(preflight.headers.get("Access-Control-Allow-Private-Network")).toBe(
      "true",
    );
    const response = await plane.app.request(path, {
      headers: { Origin: "https://local.sentry.dev" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://local.sentry.dev",
    );
    await response.body?.cancel();
    const mutation = await plane.app.request(path, {
      method: "POST",
      headers: { Origin: "https://local.sentry.dev" },
      body: "invalid",
    });
    expect(mutation.status).toBe(403);
  });
});

test("requires control authorization for a session named stream", async () => {
  const plane = createLocalControlPlane({ controlToken: CONTROL_TOKEN });
  const session = plane.sessionStore.create({
    label: "stream",
    cwd: "/work/stream",
  });
  const response = await plane.app.request("/_local/v1/sessions/stream");
  expect(response.status).toBe(401);
  const authorized = await plane.app.request(
    `/_local/v1/sessions/${session.id}`,
    { headers: controlHeaders() },
  );
  expect(authorized.status).toBe(200);
});
