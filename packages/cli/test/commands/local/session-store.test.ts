import { describe, expect, test } from "vitest";
import { createLocalSessionStore } from "../../../src/commands/local/session-store.js";

describe("LocalSessionStore", () => {
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

  test("refreshes the retention deadline when a retained session receives activity", () => {
    let now = 1000;
    const store = createLocalSessionStore({ now: () => now });
    const session = store.create({ label: "web", cwd: "/work/web" });
    store.close(session.id);

    now += 2 * 60 * 60 * 1000;
    store.recordActivity(session.id);
    now += 2 * 60 * 60 * 1000;

    expect(store.pruneExpired()).toEqual([]);
    expect(store.resolve(session.id).state).toBe("retained");
  });
});
