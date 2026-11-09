/**
 * Contract between `sentry games` in the CLI, which writes Snake scores, and
 * the games-api Worker, which reads them back for the leaderboard.
 */

/** Shape of an anonymous player handle, such as `brave-otter-4242`. */
export const PLAYER_HANDLE_REGEX = /^[a-z]{2,12}-[a-z]{2,12}-\d{4}$/;

/** Sentry application metric that carries one finished Snake game. */
export const SNAKE_SCORE_METRIC = "snake.score";

/** Only metric attribute that `SNAKE_SCORE_METRIC` may carry. */
export const SNAKE_SCORE_HANDLE_ATTRIBUTE = "handle";

/** Highest score accepted on either side. */
export const MAX_SNAKE_SCORE = 10_000;
