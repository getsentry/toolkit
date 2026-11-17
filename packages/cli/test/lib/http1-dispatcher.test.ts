import { afterEach, describe, expect, test } from "vitest";
import {
  createHttp1Dispatcher,
  destroyHttp1Dispatcher,
  type Http1Dispatcher,
} from "../../src/lib/http1-dispatcher.js";

const GLOBAL_DISPATCHER_V2 = Symbol.for("undici.globalDispatcher.2");
const global = globalThis as Record<PropertyKey, unknown>;
const original = global[GLOBAL_DISPATCHER_V2];

afterEach(() => {
  if (original === undefined) {
    delete global[GLOBAL_DISPATCHER_V2];
  } else {
    global[GLOBAL_DISPATCHER_V2] = original;
  }
});

/** Stands in for undici 8's Agent (or EnvHttpProxyAgent) as the global dispatcher. */
class FakeAgent {
  readonly options: unknown;
  destroyed = false;
  constructor(options?: unknown) {
    this.options = options;
  }
  destroy(): Promise<void> {
    this.destroyed = true;
    return Promise.resolve();
  }
}

describe("createHttp1Dispatcher", () => {
  test("builds a dispatcher of the global dispatcher's class with HTTP/2 off", () => {
    const registered = new FakeAgent();
    global[GLOBAL_DISPATCHER_V2] = registered;

    const dispatcher = createHttp1Dispatcher();

    expect(dispatcher).toBeInstanceOf(FakeAgent);
    expect(dispatcher).not.toBe(registered);
    expect((dispatcher as unknown as FakeAgent).options).toEqual({
      allowH2: false,
    });
  });

  test("returns undefined when no undici 8 dispatcher is registered", () => {
    delete global[GLOBAL_DISPATCHER_V2];

    expect(createHttp1Dispatcher()).toBeUndefined();
  });

  test("returns undefined when the dispatcher class rejects the options", () => {
    class Strict {
      constructor() {
        throw new TypeError("unsupported option");
      }
    }
    global[GLOBAL_DISPATCHER_V2] = Object.create(Strict.prototype);

    expect(createHttp1Dispatcher()).toBeUndefined();
  });
});

describe("destroyHttp1Dispatcher", () => {
  test("destroys the dispatcher", async () => {
    const dispatcher = new FakeAgent();

    await destroyHttp1Dispatcher(dispatcher);

    expect(dispatcher.destroyed).toBe(true);
  });

  test("resolves for no dispatcher", async () => {
    await expect(destroyHttp1Dispatcher(undefined)).resolves.toBeUndefined();
  });

  test("swallows a teardown rejection", async () => {
    await expect(
      destroyHttp1Dispatcher({
        destroy: () => Promise.reject(new Error("socket teardown failed")),
      } as unknown as Http1Dispatcher),
    ).resolves.toBeUndefined();
  });
});
