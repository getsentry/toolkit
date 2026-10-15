/**
 * sentry games leaderboard
 *
 * Show the top Snake scores from the last 30 days. Scores are anonymous: each
 * entry is a random player handle and a score.
 */

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
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { customFetch } from "../../lib/custom-ca.js";
import { getEnv } from "../../lib/env.js";
import { CliError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type Column, writeTable } from "../../lib/formatters/table.js";
import { MAX_SNAKE_SCORE } from "../../lib/games/score.js";
import {
  getPlayerHandle,
  PLAYER_HANDLE_REGEX,
} from "../../lib/games/player.js";
import { logger } from "../../lib/logger.js";
import type { Writer } from "../../types/index.js";

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

type LeaderboardEntry = InferOutput<typeof EntrySchema>;

type LeaderboardData = {
  period: string;
  entries: LeaderboardEntry[];
};

async function fetchLeaderboard(): Promise<LeaderboardData> {
  const baseUrl = getEnv().SENTRY_GAMES_API_URL || DEFAULT_GAMES_API_URL;
  let body: unknown;
  try {
    const response = await customFetch(
      `${baseUrl.replace(/\/+$/, "")}${LEADERBOARD_PATH}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    body = await response.json();
  } catch (error) {
    log.debug("Leaderboard request failed", error);
    throw new CliError(LOAD_FAILED_MESSAGE);
  }

  const parsed = safeParse(ResponseSchema, body);
  if (!parsed.success) {
    log.debug("Leaderboard response failed validation");
    throw new CliError(LOAD_FAILED_MESSAGE);
  }

  // Drop rows that fail validation instead of printing server-controlled text.
  const entries: LeaderboardEntry[] = [];
  for (const raw of parsed.output.entries) {
    const entry = safeParse(EntrySchema, raw);
    if (entry.success) {
      entries.push(entry.output);
    }
  }
  return { period: parsed.output.period, entries };
}

function formatLeaderboardHuman(data: LeaderboardData): string {
  if (data.entries.length === 0) {
    return "No scores in the last 30 days.";
  }

  const handle = getPlayerHandle();
  const columns: Column<LeaderboardEntry>[] = [
    { header: "RANK", value: (e) => String(e.rank) },
    {
      header: "PLAYER",
      value: (e) => (e.handle === handle ? `${e.handle} (you)` : e.handle),
    },
    { header: "SCORE", value: (e) => String(e.score) },
  ];

  const parts: string[] = [];
  const buffer: Writer = { write: (s: string) => parts.push(s) };
  writeTable(buffer, data.entries, columns);
  return parts.join("").trimEnd();
}

export const leaderboardCommand = buildCommand({
  docs: {
    brief: "Show the top Snake scores from the last 30 days",
    fullDescription:
      "Show the top Snake scores from the last 30 days.\n\n" +
      "Scores are anonymous. Each entry is a random player handle and a score. " +
      "Your own entry is marked `(you)`.\n\n" +
      "Examples:\n" +
      "  sentry games leaderboard\n" +
      "  sentry games leaderboard --json",
  },
  auth: false,
  output: { human: formatLeaderboardHuman },
  parameters: {},
  async *func(this: SentryContext) {
    const data = await fetchLeaderboard();
    yield new CommandOutput(data);
    return { hint: `You play as ${getPlayerHandle()}.` };
  },
});
