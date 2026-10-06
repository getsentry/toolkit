/**
 * Pure fixture exports without MSW dependencies.
 *
 * Use this module in environments where MSW is not available (e.g., Cloudflare Workers).
 * For MSW mocking, import from the main package entry point instead.
 */

// Import JSON fixtures
import autofixStateFixture from "./fixtures/autofix-state.json" with {
  type: "json",
};
import autofixStateExplorerFixture from "./fixtures/autofix-state-explorer.json" with {
  type: "json",
};
import clientKeyFixture from "./fixtures/client-key.json" with { type: "json" };
import eventAttachmentsFixture from "./fixtures/event-attachments.json" with {
  type: "json",
};
import eventFixture from "./fixtures/event.json" with { type: "json" };
import eventsErrorsEmptyFixture from "./fixtures/events-errors-empty.json" with {
  type: "json",
};
import eventsErrorsFixture from "./fixtures/events-errors.json" with {
  type: "json",
};
import eventsSpansEmptyFixture from "./fixtures/events-spans-empty.json" with {
  type: "json",
};
import eventsSpansFixture from "./fixtures/events-spans.json" with {
  type: "json",
};
import flamegraphFixture from "./fixtures/flamegraph.json" with {
  type: "json",
};
import transactionProfileV1Fixture from "./fixtures/transaction-profile-v1.json" with {
  type: "json",
};
import transactionProfileV1MissingFunctionFixture from "./fixtures/transaction-profile-v1-missing-function.json" with {
  type: "json",
};
import issueFixture from "./fixtures/issue.json" with { type: "json" };
import issueNullCulpritFixture from "./fixtures/issue-null-culprit.json" with {
  type: "json",
};
import issueTagValuesFixture from "./fixtures/issue-tag-values.json" with {
  type: "json",
};
import organizationFixture from "./fixtures/organization.json" with {
  type: "json",
};
import performanceEventFixture from "./fixtures/performance-event.json" with {
  type: "json",
};
import projectFixture from "./fixtures/project.json" with { type: "json" };
import releaseFixture from "./fixtures/release.json" with { type: "json" };
import replayDetailsFixture from "./fixtures/replay-details.json" with {
  type: "json",
};
import replayRecordingSegmentsFixture from "./fixtures/replay-recording-segments.json" with {
  type: "json",
};
import tagsFixture from "./fixtures/tags.json" with { type: "json" };
import teamFixture from "./fixtures/team.json" with { type: "json" };
import traceEventFixture from "./fixtures/trace-event.json" with {
  type: "json",
};
import traceItemsAttributesLogsNumberFixture from "./fixtures/trace-items-attributes-logs-number.json" with {
  type: "json",
};
import traceItemsAttributesLogsStringFixture from "./fixtures/trace-items-attributes-logs-string.json" with {
  type: "json",
};
import traceItemsAttributesSpansNumberFixture from "./fixtures/trace-items-attributes-spans-number.json" with {
  type: "json",
};
import traceItemsAttributesSpansStringFixture from "./fixtures/trace-items-attributes-spans-string.json" with {
  type: "json",
};
import traceItemsAttributesSpansNumberWithContextFixture from "./fixtures/trace-items-attributes-spans-number-with-context.json" with {
  type: "json",
};
import traceItemsAttributesSpansStringWithContextFixture from "./fixtures/trace-items-attributes-spans-string-with-context.json" with {
  type: "json",
};
import traceItemsAttributesFixture from "./fixtures/trace-items-attributes.json" with {
  type: "json",
};
import traceMetaWithNullsFixture from "./fixtures/trace-meta-with-nulls.json" with {
  type: "json",
};
import traceMetaFixture from "./fixtures/trace-meta.json" with { type: "json" };
import traceMixedFixture from "./fixtures/trace-mixed.json" with {
  type: "json",
};
import traceFixture from "./fixtures/trace.json" with { type: "json" };
import userFixture from "./fixtures/user.json" with { type: "json" };

const issueFixture2 = {
  ...issueFixture,
  id: 6507376926,
  shortId: "CLOUDFLARE-MCP-42",
  count: 1,
  title: "Error: Tool list_issues is already registered",
  firstSeen: "2025-04-11T22:51:19.403000Z",
  lastSeen: "2025-04-12T11:34:11Z",
};

// Export all fixtures
export {
  autofixStateFixture,
  autofixStateExplorerFixture,
  clientKeyFixture,
  eventAttachmentsFixture,
  eventFixture,
  eventsErrorsEmptyFixture,
  eventsErrorsFixture,
  eventsSpansEmptyFixture,
  eventsSpansFixture,
  flamegraphFixture,
  transactionProfileV1Fixture,
  transactionProfileV1MissingFunctionFixture,
  issueFixture,
  issueFixture2,
  issueNullCulpritFixture,
  issueTagValuesFixture,
  organizationFixture,
  performanceEventFixture,
  projectFixture,
  releaseFixture,
  replayDetailsFixture,
  replayRecordingSegmentsFixture,
  tagsFixture,
  teamFixture,
  traceEventFixture,
  traceItemsAttributesFixture,
  traceItemsAttributesSpansStringFixture,
  traceItemsAttributesSpansNumberFixture,
  traceItemsAttributesSpansNumberWithContextFixture,
  traceItemsAttributesSpansStringWithContextFixture,
  traceItemsAttributesLogsStringFixture,
  traceItemsAttributesLogsNumberFixture,
  traceMetaFixture,
  traceMetaWithNullsFixture,
  traceFixture,
  traceMixedFixture,
  userFixture,
};

// Re-export fixture factories
export {
  createDefaultEvent,
  createGenericEvent,
  createUnknownEvent,
  createPerformanceEvent,
  createPerformanceIssue,
  createFeedbackIssue,
  createRegressedIssue,
  createUnsupportedIssue,
  createCspIssue,
  createCspEvent,
} from "./fixtures";
