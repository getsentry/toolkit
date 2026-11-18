/** Scrubbed sentry-python Django event breadcrumbs: SDKs send epoch seconds or ISO strings. */
export const pythonBreadcrumbEvent = {
  event_id: "b".repeat(32),
  level: "error",
  platform: "python",
  timestamp: 1794947421.2,
  transaction: "/db/",
  breadcrumbs: {
    values: [
      {
        category: "django.request",
        message: "GET /db/",
        timestamp: 1794947420.913,
        level: "info",
      },
      {
        category: "query",
        message: "SELECT * FROM orders",
        timestamp: "2026-11-17T20:30:21.050Z",
        level: "info",
      },
    ],
  },
  sdk: { name: "sentry.python.django", version: "2.47.0" },
};
