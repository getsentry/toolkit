import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveEvalProvider } from "../eval-common/anthropic-client.js";

/**
 * Provider resolution drives which credential/endpoint the eval frameworks use.
 * These tests lock in the precedence (OpenRouter over Anthropic), the
 * null-when-unset skip contract, and that the OpenRouter path posts the
 * OpenAI-shaped `/chat/completions` request with the bearer key.
 */
describe("resolveEvalProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns null when no credential is set", () => {
    expect(resolveEvalProvider({})).toBeNull();
  });

  test("treats blank/whitespace keys as unset", () => {
    expect(
      resolveEvalProvider({ OPENROUTER_API_KEY: "  ", ANTHROPIC_API_KEY: "" })
    ).toBeNull();
  });

  test("prefers OpenRouter when both keys are set", () => {
    const p = resolveEvalProvider({
      OPENROUTER_API_KEY: "or-key",
      ANTHROPIC_API_KEY: "an-key",
    });
    expect(p?.provider).toBe("openrouter");
  });

  test("falls back to Anthropic direct when only its key is set", () => {
    const p = resolveEvalProvider({ ANTHROPIC_API_KEY: "an-key" });
    expect(p?.provider).toBe("anthropic");
  });

  test("OpenRouter chat posts OpenAI-shaped /chat/completions with bearer key", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "hi there" } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = resolveEvalProvider({ OPENROUTER_API_KEY: "or-key" });
    const text = await p?.chat(
      "anthropic/claude-sonnet-4.6",
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
      128
    );

    expect(text).toBe("hi there");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer or-key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("anthropic/claude-sonnet-4.6");
    expect(body.max_tokens).toBe(128);
    expect(body.messages).toHaveLength(2);
  });

  test("OpenRouter chat throws with status detail on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 }))
    );
    const p = resolveEvalProvider({ OPENROUTER_API_KEY: "or-key" });
    await expect(
      p?.chat("anthropic/claude-sonnet-4.6", [], 16)
    ).rejects.toThrow(/OpenRouter 404/);
  });

  test("honors OPENROUTER_BASE_URL override", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = resolveEvalProvider({
      OPENROUTER_API_KEY: "or-key",
      OPENROUTER_BASE_URL: "https://proxy.example/v1",
    });
    await p?.chat("m", [], 16);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://proxy.example/v1/chat/completions"
    );
  });
});
