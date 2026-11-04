/**
 * Anonymous game score reporting.
 *
 * A score is sent as a single metric tagged only with the random player
 * handle. It is emitted in its own trace with the user cleared, so it cannot
 * be joined to the CLI's other telemetry. `beforeSendMetric` in telemetry.ts
 * enforces the attribute allowlist as a second layer.
 */

// oxlint-disable-next-line sentry-cli/no-namespace-import -- Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node";
import { logger } from "../logger.js";
import { isTelemetryEnabled } from "../telemetry.js";
import { getPlayerHandle } from "./player.js";

const log = logger.withTag("games");

export const SNAKE_SCORE_METRIC = "snake.score";
export const MAX_SNAKE_SCORE = 10_000;
const SCORE_FLUSH_TIMEOUT_MS = 3000;

let pendingFlush: PromiseLike<void> = Promise.resolve();

/**
 * Record a finished Snake game. No-op when telemetry is off or the score is
 * out of range. Never throws: it runs from the game's timer, where an error
 * would crash the game before it restores the terminal.
 */
export function reportSnakeScore(score: number): void {
  if (
    !isTelemetryEnabled() ||
    !Number.isInteger(score) ||
    score < 1 ||
    score > MAX_SNAKE_SCORE
  ) {
    return;
  }

  try {
    const handle = getPlayerHandle();
    Sentry.withIsolationScope((isolationScope) => {
      isolationScope.setUser(null);
      Sentry.withScope((scope) => {
        scope.setUser(null);
        Sentry.startNewTrace(() => {
          Sentry.metrics.distribution(SNAKE_SCORE_METRIC, score, {
            attributes: { handle },
          });
        });
      });
    });
    // Metrics otherwise wait up to 5s in the SDK buffer, and on macOS the CLI
    // force-exits ~100ms after the command ends (force-exit.ts), cutting off
    // the exit flush. The command awaits `waitForSnakeScores` before it ends.
    const client = Sentry.getClient();
    if (client) {
      pendingFlush = client
        .flush(SCORE_FLUSH_TIMEOUT_MS)
        .then(undefined, (error: unknown) => {
          log.debug("Could not flush the Snake score", error);
        });
    }
  } catch (error) {
    log.debug("Could not report the Snake score", error);
  }
}

/**
 * Resolve when the scores reported so far are sent, or after the flush
 * timeout. Never rejects.
 */
export async function waitForSnakeScores(): Promise<void> {
  await pendingFlush;
}
