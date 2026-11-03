/**
 * IMPORTANT: Keep evaluation tests minimal!
 *
 * Each eval test takes 30+ seconds to run and costs API credits.
 * Only create evaluation tests for the core use cases of each tool:
 * - Primary functionality (e.g., resolving an issue)
 * - Alternative input methods (e.g., using issue URL vs org+issueId)
 * - One complex workflow example if applicable
 *
 * Avoid testing edge cases, error conditions, or minor variations in evals.
 * Use unit tests (tools.test.ts) for comprehensive coverage instead.
 */

export const FIXTURES = {
  organizationSlug: "sentry-mcp-evals",
  teamSlug: "the-goats",
  projectSlug: "cloudflare-mcp",
  issueId: "CLOUDFLARE-MCP-41",
  issueUrl: "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41/",
  testIssueUrl: "https://sentry-mcp-evals.sentry.io/issues/PEATED-A8",
  traceId: "a4d1aae7216b47ff8117cf4e09ce9d0a",
  traceUrl:
    "https://sentry-mcp-evals.sentry.io/explore/traces/trace/a4d1aae7216b47ff8117cf4e09ce9d0a/",
  dsn: "https://d20df0a1ab5031c7f3c7edca9c02814d@o4509106732793856.ingest.us.sentry.io/4509109104082945",
  dashboardUrl: "https://sentry-mcp-evals.sentry.io/dashboard/101/",
};
