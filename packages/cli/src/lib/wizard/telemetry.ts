/**
 * Telemetry for the setup wizards, recorded through the CLI's own Sentry
 * client.
 *
 * `sentry wizard` already runs inside the CLI's command transaction, so a
 * wizard flow is a `wizard.flow` span under it and each step a `wizard.step`
 * span under that. Tags go on the same scope as the CLI's. Telemetry is off
 * when the CLI's is (`SENTRY_CLI_NO_TELEMETRY`, `DO_NOT_TRACK`, or
 * `sentry cli defaults telemetry off`).
 *
 * The old wizard sent its telemetry to a project of its own; the tag names
 * stay the same so its dashboards can move over.
 */

import { type Span, setTag, setUser, startSpan } from "@sentry/node";
import type { WizardOptions } from "./utils/types.js";

/**
 * The scope helpers the wizard flows call as `Sentry.setTag(…)`.
 *
 * Report errors with `reportCliError` from `lib/error-reporting.js`, never a
 * raw `captureException`.
 */
export const Sentry = { setTag, setUser };

/**
 * Run a wizard flow in a `wizard.flow` span, tagged with the integration and
 * the kind of `<org>/<project>` target passed (`auto-detect` for none).
 */
export async function withTelemetry<F>(
  options: {
    /** Unused: the CLI decides whether telemetry is on. Kept for the flows' call sites. */
    enabled?: boolean | undefined;
    integration: string;
    wizardOptions: WizardOptions;
  },
  callback: () => F | Promise<F>,
): Promise<F> {
  setTag("integration", options.integration);
  setTag("args.target", options.wizardOptions.target?.type ?? "auto-detect");

  return await startSpan(
    {
      name: "sentry-wizard-execution",
      op: "wizard.flow",
      onlyIfParent: true,
    },
    async () => {
      updateProgress("start");
      const result = await callback();
      updateProgress("finished");
      return result;
    },
  );
}

/**
 * Run one wizard step in a `wizard.step` span and record it as the latest
 * `progress` tag, so an aborted run shows where it stopped.
 */
export function traceStep<T>(
  step: string,
  callback: (span: Span | undefined) => T,
): T {
  updateProgress(step);
  return startSpan(
    { name: step, op: "wizard.step", onlyIfParent: true },
    (span) => callback(span),
  );
}

/** Record `step` as the furthest step the wizard reached. */
export function updateProgress(step: string): void {
  setTag("progress", step);
}
