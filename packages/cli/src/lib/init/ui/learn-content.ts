/**
 * Educational Content Sequence
 *
 * Content blocks shown in the sidebar while the wizard runs,
 * transforming dead wait time into product education. After all
 * blocks complete, the panel falls back to rotating tip cards.
 *
 * All blocks MUST have exactly `BLOCK_LINE_COUNT` content lines
 * (pad with empty strings) so the panel height stays fixed and
 * doesn't jump when blocks rotate.
 */

export type ContentBlock = {
  title: string;
  lines: string[];
};

/** Fixed line count per block — keeps panel height stable. */
export const BLOCK_LINE_COUNT = 8;

export const LEARN_SEQUENCE: ContentBlock[] = [
  {
    title: "How Sentry Works",
    lines: [
      "App → SDK → Sentry → Issue",
      "",
      "The SDK runs in your app.",
      "It sends errors, traces, and",
      "context from production to",
      "Sentry, where related events",
      "become issues with the clues",
      "you need to fix them faster.",
    ],
  },
  {
    title: "Debug With Context",
    lines: [
      "Issue → Trace → Replay → Fix",
      "",
      "Start with the grouped issue.",
      "Traces show the request path.",
      "Replay shows the user session.",
      "Logs show what happened nearby.",
      "Releases show what changed.",
      "That context points to the fix.",
    ],
  },
  {
    title: "Error Tracking",
    lines: [
      "Every crash is captured with:",
      "",
      "  • Full stack trace",
      "  • Breadcrumbs & context",
      "  • Release & commit info",
      "",
      "Errors are grouped into issues",
      "so you fix causes, not symptoms.",
    ],
  },
  {
    title: "Performance Tracing",
    lines: [
      "Traces show the full journey:",
      "",
      "  Request ─┬─ DB    (120ms)",
      "           ├─ API   (340ms)",
      "           └─ Render (80ms)",
      "",
      "Find the slow piece without",
      "adding manual timers.",
    ],
  },
  {
    title: "Session Replay",
    lines: [
      "See what the user saw: DOM",
      "mutations, clicks, network",
      "calls, and console logs —",
      "all synced to the error.",
      "",
      "Debug by scrubbing a video,",
      "not reading a stack trace.",
      "",
    ],
  },
  {
    title: "Alerts & Integrations",
    lines: [
      "Get notified when it matters:",
      "",
      "  • Error spike after deploy",
      "  • Slow transaction p95",
      "  • New regression detected",
      "",
      "Routes to Slack, PagerDuty,",
      "or email automatically.",
    ],
  },
  {
    title: "What's Next?",
    lines: [
      "After setup finishes, try:",
      "",
      " sentry issue list",
      "   → see your first errors",
      " sentry issue explain <id>",
      "   → AI root-cause analysis",
      " sentry trace list",
      "   → explore performance",
    ],
  },
];
