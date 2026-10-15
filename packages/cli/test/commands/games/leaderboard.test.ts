import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { leaderboardCommand } from "../../../src/commands/games/leaderboard.js";
import { withEnv } from "../../../src/lib/env.js";
import { CliError } from "../../../src/lib/errors.js";
import { getPlayerHandle } from "../../../src/lib/games/player.js";
import { useTestConfigDir } from "../../helpers.js";
import { createMockServer, type MockServer } from "../../mocks/server.js";

useTestConfigDir("test-games-leaderboard-");

const PATH = "/v1/snake/leaderboard";

async function run(
  server: MockServer,
  flags: { json: boolean },
): Promise<string> {
  const chunks: string[] = [];
  const context = {
    stdout: { write: (s: string) => chunks.push(s) },
    stderr: { write: () => true },
    stdin: { isTTY: false },
  };
  const func = await leaderboardCommand.loader();
  await withEnv({ ...process.env, SENTRY_GAMES_API_URL: server.url }, () =>
    func.call(context as never, flags as never),
  );
  return chunks.join("");
}

async function withServer<T>(
  status: number,
  body: unknown,
  fn: (server: MockServer) => Promise<T>,
): Promise<T> {
  const server = createMockServer([
    { method: "GET", path: PATH, response: body, status },
  ]);
  await server.start();
  try {
    return await fn(server);
  } finally {
    server.stop();
  }
}

describe("games leaderboard", () => {
  const mockedFetch = globalThis.fetch;
  beforeEach(() => {
    // The preload blocks network access; the mock server listens on localhost.
    globalThis.fetch = (globalThis as { __originalFetch?: typeof fetch })
      .__originalFetch as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = mockedFetch;
  });

  test("renders the table and marks the local player", async () => {
    const handle = getPlayerHandle();
    const out = await withServer(
      200,
      {
        period: "30d",
        entries: [
          { rank: 1, handle: "brave-otter-4242", score: 57 },
          { rank: 2, handle, score: 40 },
        ],
      },
      (s) => run(s, { json: false }),
    );
    expect(out).toContain("brave-otter-4242");
    expect(out).toContain(`${handle} (you)`);
    expect(out).toContain(`You play as ${handle}.`);
  });

  test("drops invalid rows", async () => {
    const out = await withServer(
      200,
      {
        period: "30d",
        entries: [
          { rank: 1, handle: "\x1b[31m-evil-0000", score: 5 },
          { rank: 2, handle: "good-wolf-0101", score: 0 },
          { rank: 3, handle: "ok-fox-0202", score: 10_001 },
          { rank: 4, handle: "fine-fox-0303", score: 9 },
        ],
      },
      (s) => run(s, { json: false }),
    );
    expect(out).toContain("fine-fox-0303");
    expect(out).not.toContain("\x1b[31m");
    expect(out).not.toContain("good-wolf-0101");
    expect(out).not.toContain("ok-fox-0202");
  });

  test("shows a message when there are no scores", async () => {
    const out = await withServer(200, { period: "30d", entries: [] }, (s) =>
      run(s, { json: false }),
    );
    expect(out).toContain("No scores in the last 30 days.");
  });

  test("fails with a generic message on a server error", async () => {
    const error = await withServer(
      500,
      { error: "secret internal detail" },
      (s) => run(s, { json: false }).catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toBe(
      "Could not load the leaderboard. Try again later.",
    );
  });

  test("--json returns the period and validated entries", async () => {
    const out = await withServer(
      200,
      {
        period: "30d",
        entries: [
          { rank: 1, handle: "brave-otter-4242", score: 57 },
          { rank: 2, handle: "bad handle", score: 3 },
        ],
      },
      (s) => run(s, { json: true }),
    );
    expect(JSON.parse(out)).toEqual({
      period: "30d",
      entries: [{ rank: 1, handle: "brave-otter-4242", score: 57 }],
    });
  });
});
