import { pushToSpotlightBuffer } from "@spotlightjs/spotlight/sdk";
import { describe, expect, test, vi } from "vitest";
import { createLocalSessionStore } from "../../../src/commands/local/session-store.js";

describe("LocalSessionStore", () => {
  test("grows retention without losing envelopes, IDs or live subscribers", () => {
    const store = createLocalSessionStore();
    const session = store.create({
      label: "web",
      cwd: "/web",
      maxEnvelopes: 2,
    });
    const buffer = store.getBuffer(session.id);
    const messages: string[] = [];
    const reader = buffer.subscribe((container) =>
      messages.push(container.getData().toString()),
    );
    function ingest(id: string) {
      pushToSpotlightBuffer({
        spotlightBuffer: buffer,
        contentType: "application/x-sentry-envelope",
        body: Buffer.from(
          `{"event_id":"${id}"}\n{"type":"event"}\n{"message":"${id}"}`,
        ),
      });
      buffer.stream(reader);
    }
    ingest("one");
    ingest("two");
    const retained = buffer.read({ all: true });
    expect(store.resolve(session.id).maxEnvelopes).toBe(2);
    store.setMaxEnvelopes(session.id, 4);
    expect(store.getBuffer(session.id)).toBe(buffer);
    expect(buffer.read({ all: true })).toEqual(retained);
    ingest("three");
    ingest("four");
    expect(buffer.read({ all: true })).toHaveLength(4);
    expect(messages).toHaveLength(4);
    expect(() => store.setMaxEnvelopes(session.id, 3)).toThrow(
      /retained envelopes/,
    );
    expect(buffer.read({ all: true })).toHaveLength(4);
    buffer.clear();
    store.setMaxEnvelopes(session.id, 1);
    ingest("five");
    ingest("six");
    expect(buffer.read({ all: true })).toHaveLength(1);
    expect(messages).toHaveLength(6);
    buffer.unsubscribe(reader);
  });

  test("keeps original arrival times when resizing", () => {
    const store = createLocalSessionStore();
    const session = store.create({
      label: "timed",
      cwd: "/timed",
      maxEnvelopes: 2,
    });
    const buffer = store.getBuffer(session.id);
    const time = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      pushToSpotlightBuffer({
        spotlightBuffer: buffer,
        contentType: "application/x-sentry-envelope",
        body: Buffer.from('{"event_id":"old"}\n{"type":"event"}\n{}'),
      });
      time.mockReturnValue(61001);
      store.setMaxEnvelopes(session.id, 4);
      expect(buffer.read({ timeWindow: 60 })).toHaveLength(0);
      expect(buffer.read({ all: true })).toHaveLength(1);
    } finally {
      time.mockRestore();
    }
  });

  test("creates isolated sessions with stable IDs and readable labels", () => {
    const store = createLocalSessionStore({ now: () => 1000 });

    const web = store.create({ label: "web", cwd: "/work/web" });
    const api = store.create({ label: "api", cwd: "/work/api" });

    expect(web.id).not.toBe(api.id);
    expect(web.label).toBe("web");
    expect(store.resolve(web.id)).toMatchObject({ id: web.id, label: "web" });
    expect(store.resolve("api")).toMatchObject({
      id: api.id,
      cwd: "/work/api",
    });
  });

  test("rejects ambiguous labels instead of selecting an arbitrary session", () => {
    const store = createLocalSessionStore({ now: () => 1000 });
    store.create({ label: "web", cwd: "/work/one" });
    store.create({ label: "web", cwd: "/work/two" });

    expect(() => store.resolve("web")).toThrow(/ambiguous/i);
  });

  test("reuses a session when an agent retries with the same client ID", () => {
    const store = createLocalSessionStore();
    const first = store.create({
      clientId: "agent-turn-7",
      label: "web",
      cwd: "/work/web",
    });
    const retried = store.create({
      clientId: "agent-turn-7",
      label: "web",
      cwd: "/work/web",
    });

    expect(retried.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
  });

  test("retains a closed session for three hours and then expires it", () => {
    let now = 1000;
    const store = createLocalSessionStore({ now: () => now });
    const session = store.create({ label: "web", cwd: "/work/web" });

    store.close(session.id);
    now += 3 * 60 * 60 * 1000 - 1;
    expect(store.pruneExpired()).toEqual([]);
    expect(store.resolve(session.id).state).toBe("retained");

    now += 1;
    expect(store.pruneExpired()).toEqual([session.id]);
    expect(() => store.resolve(session.id)).toThrow(/not found/i);
  });

  test("reports the sessions after each create, close, and expiry, not on activity or reset", () => {
    let now = 1000;
    const onChange = vi.fn();
    const store = createLocalSessionStore({ now: () => now, onChange });
    const session = store.create({ label: "web", cwd: "/work/web" });
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: session.id, state: "open" }),
    ]);
    store.create({ clientId: "retry", label: "api", cwd: "/work/api" });
    store.create({ clientId: "retry", label: "api", cwd: "/work/api" });
    expect(onChange).toHaveBeenCalledTimes(2);

    store.recordActivity(session.id);
    store.reset(session.id);
    expect(onChange).toHaveBeenCalledTimes(2);

    store.close(session.id);
    store.close(session.id);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.lastCall?.[0]).toContainEqual(
      expect.objectContaining({ id: session.id, state: "retained" }),
    );

    expect(store.pruneExpired()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(3);
    now += 3 * 60 * 60 * 1000;
    expect(store.pruneExpired()).toEqual([session.id]);
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(onChange.mock.lastCall?.[0]).toEqual([
      expect.objectContaining({ label: "api" }),
    ]);
  });

  test("does not extend the expiry of a closed session after activity", () => {
    let now = 1000;
    const store = createLocalSessionStore({ now: () => now });
    const session = store.create({ label: "web", cwd: "/work/web" });
    store.close(session.id);

    now += 2 * 60 * 60 * 1000;
    store.recordActivity(session.id);
    now += 2 * 60 * 60 * 1000;

    expect(store.pruneExpired()).toEqual([session.id]);
    expect(() => store.resolve(session.id)).toThrow(/not found/i);
  });

  test("lifecycle notifications carry the frozen deadline through close and reset", () => {
    let now = 1000;
    const store = createLocalSessionStore({ now: () => now });
    const session = store.create({ label: "web", cwd: "/work/web" });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(session.id, listener);
    store.reset(session.id);
    expect(listener).toHaveBeenLastCalledWith({
      state: "open",
      action: "reset",
    });
    const closed = store.close(session.id);
    expect(listener).toHaveBeenLastCalledWith({
      state: "retained",
      expiresAt: closed.expiresAt,
    });
    now += 60_000;
    expect(store.close(session.id).expiresAt).toBe(closed.expiresAt);
    store.reset(session.id);
    expect(listener).toHaveBeenLastCalledWith({
      state: "retained",
      action: "reset",
      expiresAt: closed.expiresAt,
    });
    expect(store.resolve(session.id).expiresAt).toBe(closed.expiresAt);
    unsubscribe();
  });
});
