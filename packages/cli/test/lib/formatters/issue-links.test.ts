/**
 * Issue link formatter tests.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { formatIssueLinkResult } from "../../../src/lib/formatters/issue-links.js";
import type { ExternalIssueLinkResult } from "../../../src/lib/issue-links.js";
import { useEnvSandbox } from "../../helpers.js";

const URL = "https://github.com/example/app/issues/42";

describe("formatIssueLinkResult", () => {
  useEnvSandbox(["SENTRY_PLAIN_OUTPUT"]);

  beforeEach(() => {
    process.env.SENTRY_PLAIN_OUTPUT = "1";
  });

  test.each([
    [
      { action: "link", linked: false, changed: false, dryRun: true },
      `Would link ${URL} to test-org/123. (dry run)`,
    ],
    [
      { action: "link", linked: true, changed: false, dryRun: true },
      `Already linked: ${URL}. (dry run)`,
    ],
    [
      { action: "link", linked: true, changed: true },
      `Linked ${URL} to test-org/123.`,
    ],
    [
      { action: "link", linked: true, changed: false },
      `Already linked: ${URL}.`,
    ],
    [
      { action: "unlink", linked: true, changed: false, dryRun: true },
      `Would unlink ${URL} from test-org/123. (dry run)`,
    ],
    [
      { action: "unlink", linked: false, changed: false, dryRun: true },
      `Already unlinked: ${URL}. (dry run)`,
    ],
    [
      { action: "unlink", linked: false, changed: true },
      `Unlinked ${URL} from test-org/123. The external issue was not deleted.`,
    ],
    [
      { action: "unlink", linked: false, changed: false },
      `Already unlinked: ${URL}.`,
    ],
  ] as const)("renders %j", (state, expected) => {
    const result: ExternalIssueLinkResult = {
      org: "test-org",
      issueId: "123",
      externalIssue: { url: URL },
      ...state,
    };
    expect(formatIssueLinkResult(result)).toBe(expected);
  });
});
