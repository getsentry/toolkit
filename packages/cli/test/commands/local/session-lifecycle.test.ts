import { describe, expect, test } from "vitest";
import { createLocalControlPlane } from "../../../src/commands/local/control-plane.js";
import {
  createLocalSessionStore,
  SESSION_RETENTION_MS,
} from "../../../src/commands/local/session-store.js";

const headers = { Authorization: "Bearer lifecycle-test" };
const envelope = (message: string) =>
  `${JSON.stringify({ event_id: crypto.randomUUID() })}\n{"type":"event"}\n${JSON.stringify({ message })}\n`;
async function fixture() {
  let now = 1000;
  const store = createLocalSessionStore({ now: () => now });
  const plane = createLocalControlPlane({
    controlToken: "lifecycle-test",
    sessionStore: store,
  });
  const response = await plane.app.request("/_local/v1/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "web", cwd: "/web" }),
  });
  const session = (await response.json()) as {
    id: string;
    ingestUrl: string;
    streamUrl: string;
  };
  const ingest = (message: string) =>
    plane.app.request(session.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: envelope(message),
    });
  const action = (name: string) =>
    plane.app.request(`/_local/v1/sessions/${session.id}/${name}`, {
      method: "POST",
      headers,
    });
  return {
    ...plane,
    store,
    session,
    ingest,
    action,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Local session lifecycle", () => {
  test("close freezes ingestion and expiry while preserving saved envelopes", async () => {
    const f = await fixture();
    expect((await f.ingest("saved")).status).toBe(204);
    const closed = await (await f.action("close")).json();
    f.advance(1000);
    expect((await f.ingest("late")).status).toBe(410);
    expect(await (await f.action("close")).json()).toEqual(closed);
    expect(
      f.store.getRetention(f.session.id).getSettings().retainedEnvelopes,
    ).toBe(1);
    f.store.recordActivity(f.session.id);
    f.advance(SESSION_RETENTION_MS);
    expect(f.store.pruneExpired()).toEqual([f.session.id]);
  });

  test("rejects an ingestion body that finishes after close", async () => {
    const f = await fixture();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const pending = f.app.request(f.session.ingestUrl, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await f.action("close");
    controller!.enqueue(new TextEncoder().encode(envelope("late body")));
    controller!.close();
    expect((await pending).status).toBe(410);
    expect(
      f.store.getRetention(f.session.id).getSettings().retainedEnvelopes,
    ).toBe(0);
  });

  test("notifies every reader about reset and close, then replays a finite archive", async () => {
    const f = await fixture();
    await f.ingest("before-reset");
    const first = await f.app.request(f.session.streamUrl);
    const second = await f.app.request(f.session.streamUrl);
    const readings = [first.text(), second.text()];
    await f.action("reset");
    await f.ingest("after-reset");
    await f.action("close");
    for (const text of await Promise.all(readings)) {
      expect(text).toContain('"action":"reset"');
      expect(text).toContain("after-reset");
      expect(text).toContain('"state":"retained"');
      expect(text.lastIndexOf('"state":"retained"')).toBeGreaterThan(
        text.indexOf("after-reset"),
      );
    }
    const replay = await (await f.app.request(f.session.streamUrl)).text();
    expect(replay).toContain("after-reset");
    expect(replay).not.toContain("before-reset");
    expect(replay).toContain('"state":"retained"');
    await f.action("reset");
    const empty = await (await f.app.request(f.session.streamUrl)).text();
    expect(empty).not.toContain("after-reset");
    expect(empty).toContain('"state":"retained"');
  });
});
