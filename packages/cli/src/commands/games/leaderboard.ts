/**
 * sentry games leaderboard
 *
 * Show the top Snake scores from the last 30 days. Scores are anonymous: each
 * entry is a random player handle and a score.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { formatTable } from "../../lib/formatters/table.js";
import {
  fetchSnakeLeaderboard,
  type SnakeLeaderboardEntry,
} from "../../lib/games/leaderboard-api.js";
import { getPlayerHandle } from "../../lib/games/player.js";

type LeaderboardData = {
  period: string;
  entries: (SnakeLeaderboardEntry & { you: boolean })[];
};

function formatLeaderboardHuman(data: LeaderboardData): string {
  if (data.entries.length === 0) {
    return "No scores in the last 30 days.";
  }
  return formatTable(data.entries, [
    { header: "RANK", value: (e) => String(e.rank) },
    {
      header: "PLAYER",
      value: (e) => (e.you ? `${e.handle} (you)` : e.handle),
    },
    { header: "SCORE", value: (e) => String(e.score) },
  ]).trimEnd();
}

export const leaderboardCommand = buildCommand({
  docs: {
    brief: "Show the top Snake scores from the last 30 days",
    fullDescription:
      "Show the top Snake scores from the last 30 days.\n\n" +
      "Scores are anonymous. Each entry is a random player handle and a score. " +
      "Your own entry is marked `(you)`.",
    examples: [
      {
        description: "Show the top Snake scores",
        run: "games leaderboard",
      },
      {
        description: "Show the scores as JSON",
        run: "games leaderboard --json",
      },
    ],
  },
  auth: false,
  output: { human: formatLeaderboardHuman },
  parameters: {},
  async *func(this: SentryContext) {
    const { period, entries } = await fetchSnakeLeaderboard();
    const handle = getPlayerHandle();
    const data: LeaderboardData = {
      period,
      entries: entries.map((e) => ({ ...e, you: e.handle === handle })),
    };
    yield new CommandOutput(data);
    return { hint: `You play as ${handle}.` };
  },
});
