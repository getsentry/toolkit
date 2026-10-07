/**
 * Anonymous game score reporting.
 *
 * A score is sent as a single metric tagged only with the random player
 * handle. It is emitted in its own trace with the user cleared, so it cannot
 * be joined to the CLI's other telemetry. `beforeSendMetric` in telemetry.ts
 * enforces the attribute allowlist as a second layer.
 */

// oxlint-disable-next-line sentry-cli/no-namespace-import -- Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import { isTelemetryEnabled } from "../telemetry.js";
import { getPlayerHandle } from "./player.js";

export const SNAKE_SCORE_METRIC = "snake.score";
export const MAX_SNAKE_SCORE = 10_000;

/** Record a finished Snake game. No-op when telemetry is off or the score is out of range. */
export function reportSnakeScore(score: number): void {
  if (
    !isTelemetryEnabled() ||
    !Number.isInteger(score) ||
    score < 1 ||
    score > MAX_SNAKE_SCORE
  ) {
    return;
  }

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
}
