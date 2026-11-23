import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { createLocalControlPlane } from "../../../src/commands/local/control-plane.js";
import { MAX_BODY_BYTES } from "../../../src/commands/local/server.js";
import { LOCAL_OVERSIZED_EVENT } from "../../../src/commands/local/viewer-protocol.js";
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
    expect((await f.ingest("saved")).status).toBe(200);
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

  /**
   * Start a chunked ingest with one byte, close the session while the body is
   * still being read, then send the rest. The tail must hear about the 413
   * before the session's closing frame.
   */
  async function closeDuringOversizedIngest(
    body: Uint8Array,
    headers: Record<string, string> = {},
  ) {
    const f = await fixture();
    const tail = (await f.app.request(f.session.streamUrl)).text();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let firstByteRead: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      firstByteRead = resolve;
    });
    const pending = f.app.request(f.session.ingestUrl, {
      method: "POST",
      headers,
      body: new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(body.subarray(0, 1));
        },
        // Called once the receiver has taken the first byte and wants more.
        pull: () => firstByteRead(),
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await reading;
    await f.action("close");
    controller!.enqueue(body.subarray(1));
    controller!.close();
    const status = (await pending).status;
    const text = await tail;
    expect(
      f.store.getRetention(f.session.id).getSettings().retainedEnvelopes,
    ).toBe(0);
    return { status, text };
  }

  test("tells the tail about an encoded 413 that finishes after close", async () => {
    const { status, text } = await closeDuringOversizedIngest(
      new Uint8Array(MAX_BODY_BYTES + 1).fill(120),
    );
    expect(status).toBe(413);
    expect(text).toContain(`event: ${LOCAL_OVERSIZED_EVENT}`);
    expect(text.indexOf(`event: ${LOCAL_OVERSIZED_EVENT}`)).toBeLessThan(
      text.lastIndexOf('"state":"retained"'),
    );
  });

  test("tells the tail about a decoded 413 that finishes after close", async () => {
    const { status, text } = await closeDuringOversizedIngest(
      gzipSync(Buffer.alloc(33 * 1024 * 1024)),
      { "Content-Encoding": "gzip" },
    );
    expect(status).toBe(413);
    expect(text).toContain(`event: ${LOCAL_OVERSIZED_EVENT}`);
    expect(text.indexOf(`event: ${LOCAL_OVERSIZED_EVENT}`)).toBeLessThan(
      text.lastIndexOf('"state":"retained"'),
    );
  });

  test("keeps a delivery whose body arrived before close, even while it decodes", async () => {
    const f = await fixture();
    const pending = f.app.request(f.session.ingestUrl, {
      method: "POST",
      headers: { "Content-Encoding": "gzip" },
      body: gzipSync(envelope("x".repeat(8 * 1024 * 1024))),
    });
    // The in-memory body is read within microtasks, so close lands while the
    // delivery is decoding.
    await new Promise((resolve) => setImmediate(resolve));
    await f.action("close");
    expect((await pending).status).toBe(200);
    expect(
      f.store.getRetention(f.session.id).getSettings().retainedEnvelopes,
    ).toBe(1);
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
