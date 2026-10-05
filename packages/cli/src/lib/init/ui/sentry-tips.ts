/**
 * Sentry Tips
 *
 * Curated set of short product facts shown rotating in the sidebar of
 * the Ink sidebar while the wizard runs. Each tip should:
 *
 *   - fit comfortably in ~36 columns (the sidebar width) when wrapped
 *   - mention a concrete capability the user can apply after onboarding
 *   - avoid sales copy — the wizard isn't a marketing surface
 *
 * The runner picks one tip on mount and rotates through the rest on a
 * fixed interval, so the panel feels alive even during long-running
 * tool calls. Tips ARE NOT used by the LoggingUI path.
 */

export type SentryTip = {
  /** Short heading rendered as the section title. */
  title: string;
  /** 1–3 sentences of body text. Plain prose, no markdown. */
  body: string;
};

/**
 * Tip library. Order is the rotation order — keep highest-impact tips
 * first so users who only see the wizard for a few seconds catch them.
 */
export const SENTRY_TIPS: SentryTip[] = [
  {
    title: "Errors → Traces in one click",
    body: "Every error in Sentry is linked to the trace that produced it. From an issue page, jump straight to the full request waterfall to see what slow query or upstream call set off the failure.",
  },
  {
    title: "Session Replay shows the user's view",
    body: "Replay keeps UI changes, clicks, network calls, and console logs next to the related error. When the stack trace says what broke, replay shows what the user did before it.",
  },
  {
    title: "Tracing finds the slow piece",
    body: "Tracing connects the slow or failed request to its spans, so you can see whether the database, an HTTP call, rendering, or your own code caused the wait.",
  },
  {
    title: "Alerts on real signals",
    body: "Configure alert rules on issue frequency, regression after release, or trace duration percentiles. Slack, PagerDuty, and email integrations route alerts to the right team automatically.",
  },
  {
    title: "Releases tie deploys to errors",
    body: "Tag every deploy with a release version and Sentry will tell you which commits introduced new issues, which were resolved by a release, and which are still regressing in production.",
  },
  {
    title: "Source maps make stack traces readable",
    body: "Source maps connect minified production frames back to the code you wrote. Upload them with the release so an issue opens on the useful TypeScript or JSX line.",
  },
  {
    title: "Cron monitoring catches missed jobs",
    body: "Wrap a scheduled job with Sentry's Crons SDK and get an alert when it fails or doesn't run on time — useful for nightly reports, billing rollups, and ETL pipelines.",
  },
  {
    title: "User Feedback widget",
    body: 'Drop a feedback widget on your site and Sentry attaches user reports directly to the matching error. No more triaging vague "the app broke" tickets without context.',
  },
  {
    title: "Profiling for hot code paths",
    body: "Profiling adds function-level cost to the same debugging story. Pair it with a trace to see which code path burned CPU during a slow transaction.",
  },
  {
    title: "Agent Tracing for LLM apps",
    body: "If your app calls an LLM, Sentry's Agent Tracing surfaces token cost, latency, and failure rate per model and per route. Catch a regression in prompt cost before the bill arrives.",
  },
  {
    title: "Seer: AI-powered debugging",
    body: "After setup, run `sentry issue explain <issue-id>`. Seer uses the issue, stack trace, and nearby context to summarize the likely cause and point at a fix.",
  },
  {
    title: "Self-hosted is a flag away",
    body: "Using self-hosted Sentry? Point the CLI at your instance with `SENTRY_URL`. Your SDK setup and debugging workflow stay the same.",
  },
];
