import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stubOpenRouter } from "../__tests__/openrouter-stub";
import {
  createNativeModelFallbacks,
  FALLBACK_MODEL,
  KIMI_FALLBACK_MODEL,
  PRIMARY_MODEL,
} from "./model-fallback";

const overloaded = { message: "overloaded", status: 503 };
const badRequest = { message: "bad request", status: 400 };

/**
 * Run one model call to completion with fake timers, and return the models
 * it asked and how many milliseconds after the start it asked each one.
 */
async function generate(replies: Parameters<typeof stubOpenRouter>[0]) {
  stubOpenRouter(replies);
  const start = Date.now();
  const calls: Array<[string, number]> = [];
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    calls.push([
      (JSON.parse(args[1]?.body as string) as { model: string }).model,
      Date.now() - start,
    ]);
    return fetch(...args);
  });
  const result = generateText({
    maxRetries: 0,
    model: createNativeModelFallbacks(PRIMARY_MODEL, "sk-or-test"),
    prompt: "hi",
  });
  // Keep the rejection handled while the timers run.
  const settled = result.then(
    (value) => ({ error: undefined, value }),
    (error: unknown) => ({ error, value: undefined }),
  );
  await vi.runAllTimersAsync();
  return { calls, ...(await settled) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createNativeModelFallbacks", () => {
  test("uses the first model that answers and reports its model id", async () => {
    const { calls, value } = await generate({
      [PRIMARY_MODEL]: [badRequest],
      [FALLBACK_MODEL]: [{ text: "from fallback" }],
    });

    expect(value?.text).toBe("from fallback");
    expect(value?.response.modelId).toBe(FALLBACK_MODEL);
    expect(calls).toEqual([
      [PRIMARY_MODEL, 0],
      [FALLBACK_MODEL, 0],
    ]);
  });

  test("starts every call with the primary model", async () => {
    const requests = stubOpenRouter({
      [PRIMARY_MODEL]: [badRequest, { text: "from primary" }],
      [FALLBACK_MODEL]: [{ text: "from fallback" }],
    });
    const model = createNativeModelFallbacks(PRIMARY_MODEL, "sk-or-test");

    await generateText({ maxRetries: 0, model, prompt: "first" });
    const second = await generateText({
      maxRetries: 0,
      model,
      prompt: "second",
    });

    expect(second.response.modelId).toBe(PRIMARY_MODEL);
    expect(requests.map((request) => request.model)).toEqual([
      PRIMARY_MODEL,
      FALLBACK_MODEL,
      PRIMARY_MODEL,
    ]);
  });

  test("retries retryable errors 3 s apart, twice per call across the models", async () => {
    const { calls, value } = await generate({
      [PRIMARY_MODEL]: [overloaded, overloaded, overloaded],
      [FALLBACK_MODEL]: [overloaded],
      [KIMI_FALLBACK_MODEL]: [{ text: "from kimi" }],
    });

    expect(value?.text).toBe("from kimi");
    expect(calls).toEqual([
      [PRIMARY_MODEL, 0],
      [PRIMARY_MODEL, 3000],
      [PRIMARY_MODEL, 6000],
      [FALLBACK_MODEL, 6000],
      [KIMI_FALLBACK_MODEL, 6000],
    ]);
  });

  test("spends the retries left on the next model", async () => {
    const { calls, value } = await generate({
      [PRIMARY_MODEL]: [badRequest],
      [FALLBACK_MODEL]: [overloaded, { text: "from fallback" }],
    });

    expect(value?.text).toBe("from fallback");
    expect(calls).toEqual([
      [PRIMARY_MODEL, 0],
      [FALLBACK_MODEL, 0],
      [FALLBACK_MODEL, 3000],
    ]);
  });

  test("waits for Retry-After, up to 30 s", async () => {
    const { calls } = await generate({
      [PRIMARY_MODEL]: [
        { headers: { "retry-after": "10" }, message: "slow down", status: 429 },
        { headers: { "retry-after": "60" }, message: "slow down", status: 429 },
        { text: "from primary" },
      ],
    });

    expect(calls).toEqual([
      [PRIMARY_MODEL, 0],
      [PRIMARY_MODEL, 10_000],
      [PRIMARY_MODEL, 40_000],
    ]);
  });

  test("backs off from 1 s on connection resets", async () => {
    const reset = () => ({
      reject: new TypeError("fetch failed", {
        cause: Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
        }),
      }),
    });
    const { calls } = await generate({
      [PRIMARY_MODEL]: [reset(), reset(), { text: "from primary" }],
    });

    expect(calls).toEqual([
      [PRIMARY_MODEL, 0],
      [PRIMARY_MODEL, 1000],
      [PRIMARY_MODEL, 3000],
    ]);
  });

  test("never retries the last model and throws its error", async () => {
    const { calls, error } = await generate({
      [PRIMARY_MODEL]: [badRequest],
      [FALLBACK_MODEL]: [badRequest],
      [KIMI_FALLBACK_MODEL]: [{ message: "kimi unavailable", status: 503 }],
    });

    expect(error).toHaveProperty("message", "kimi unavailable");
    expect(calls.map(([model]) => model)).toEqual([
      PRIMARY_MODEL,
      FALLBACK_MODEL,
      KIMI_FALLBACK_MODEL,
    ]);
  });

  test("drops temperature for the OpenAI fallback model", async () => {
    const requests = stubOpenRouter({
      [PRIMARY_MODEL]: [badRequest],
      [FALLBACK_MODEL]: [badRequest],
      [KIMI_FALLBACK_MODEL]: [{ text: "from kimi" }],
    });

    await generateText({
      maxRetries: 0,
      model: createNativeModelFallbacks(PRIMARY_MODEL, "sk-or-test"),
      prompt: "hi",
      temperature: 0,
    });

    expect(
      requests.map((request) => [request.model, request.temperature]),
    ).toEqual([
      [PRIMARY_MODEL, 0],
      [FALLBACK_MODEL, undefined],
      [KIMI_FALLBACK_MODEL, 0],
    ]);
  });
});
