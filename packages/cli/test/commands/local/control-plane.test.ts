import { request } from "node:http";
import { describe, expect, test } from "vitest";
import { createLocalControlPlane } from "../../../src/commands/local/control-plane.js";
import { tryListen } from "../../../src/commands/local/server.js";

const CONTROL_TOKEN = "control-token";

function controlHeaders() {
  return { Authorization: `Bearer ${CONTROL_TOKEN}` };
}

describe("Local control plane", () => {
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
    for (const origin of ["https://local.sentry.dev", "https://example.com"]) {
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
