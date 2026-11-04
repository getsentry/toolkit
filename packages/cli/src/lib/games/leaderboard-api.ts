/**
 * Client for the games-api Worker (apps/games-api), which serves the Snake
 * leaderboard. The Worker is public and needs no Sentry token.
 */

import {
  MAX_SNAKE_SCORE,
  PLAYER_HANDLE_REGEX,
} from "@sentry/toolkit-core/games";
import {
  array,
  type InferOutput,
  integer,
  maxValue,
  minValue,
  number,
  object,
  pipe,
  regex,
  safeParse,
  string,
  unknown,
} from "valibot";
import { customFetch } from "../custom-ca.js";
import { getEnv } from "../env.js";
import { ApiError, CliError, EXIT } from "../errors.js";
import { logger } from "../logger.js";

const log = logger.withTag("games.leaderboard");

const DEFAULT_GAMES_API_URL = "https://games.sentry.new";
const LEADERBOARD_PATH = "/v1/snake/leaderboard";
const REQUEST_TIMEOUT_MS = 5000;
const LOAD_FAILED_MESSAGE = "Could not load the leaderboard. Try again later.";

const ResponseSchema = object({
  period: string(),
  entries: array(unknown()),
});

const EntrySchema = object({
  rank: pipe(number(), integer(), minValue(1)),
  handle: pipe(string(), regex(PLAYER_HANDLE_REGEX)),
  score: pipe(number(), integer(), minValue(1), maxValue(MAX_SNAKE_SCORE)),
});

export type SnakeLeaderboardEntry = InferOutput<typeof EntrySchema>;

export type SnakeLeaderboard = {
  period: string;
  entries: SnakeLeaderboardEntry[];
};

/**
 * Fetch the Snake leaderboard. Rows that fail validation are dropped, so
 * server-controlled text never reaches the terminal.
 */
export async function fetchSnakeLeaderboard(): Promise<SnakeLeaderboard> {
  const baseUrl = getEnv().SENTRY_GAMES_API_URL || DEFAULT_GAMES_API_URL;
  let response: Response;
  try {
    response = await customFetch(
      `${baseUrl.replace(/\/+$/, "")}${LEADERBOARD_PATH}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
  } catch (error) {
    log.debug("Leaderboard request failed", error);
    throw new CliError(LOAD_FAILED_MESSAGE, EXIT.API);
  }
  let body: unknown;
  if (response.ok) {
    try {
      body = await response.json();
    } catch (error) {
      log.debug("Leaderboard response is not JSON", error);
    }
  }
  const parsed = safeParse(ResponseSchema, body);
  if (!parsed.success) {
    throw new ApiError(
      LOAD_FAILED_MESSAGE,
      response.status,
      undefined,
      LEADERBOARD_PATH,
    );
  }

  const entries: SnakeLeaderboardEntry[] = [];
  for (const raw of parsed.output.entries) {
    const entry = safeParse(EntrySchema, raw);
    if (entry.success) {
      entries.push(entry.output);
    }
  }
  return { period: parsed.output.period, entries };
}
