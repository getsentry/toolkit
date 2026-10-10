import { afterEach, describe, expect, test } from "vitest";
import { closeGlobalDispatcher } from "../../src/lib/close-dispatcher.js";

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
const global = globalThis as Record<PropertyKey, unknown>;
const original = global[GLOBAL_DISPATCHER];

afterEach(() => {
  if (original === undefined) {
    delete global[GLOBAL_DISPATCHER];
  } else {
    global[GLOBAL_DISPATCHER] = original;
  }
});

describe("closeGlobalDispatcher", () => {
  test("destroys the global dispatcher when one is registered", async () => {
    let destroyed = false;
    global[GLOBAL_DISPATCHER] = {
      destroy: () => {
        destroyed = true;
        return Promise.resolve();
      },
    };

    await closeGlobalDispatcher();

    expect(destroyed).toBe(true);
  });

  test("resolves without throwing when no dispatcher is registered", async () => {
    delete global[GLOBAL_DISPATCHER];

    await expect(closeGlobalDispatcher()).resolves.toBeUndefined();
  });

  test("resolves when the dispatcher has no destroy method", async () => {
    global[GLOBAL_DISPATCHER] = {};

    await expect(closeGlobalDispatcher()).resolves.toBeUndefined();
  });

  test("swallows a rejection from destroy so the exit path is never disrupted", async () => {
    global[GLOBAL_DISPATCHER] = {
      destroy: () => Promise.reject(new Error("socket teardown failed")),
    };

    await expect(closeGlobalDispatcher()).resolves.toBeUndefined();
  });
});
