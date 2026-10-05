import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  fakeLog,
  mockListIssueAlertsPaginated,
  mockListMetricAlertsPaginated,
  noop,
} = vi.hoisted(() => {
  function _noop() {
    // intentional no-op
  }

  const _fakeLog: {
    warn: ReturnType<typeof vi.fn>;
    withTag: () => typeof _fakeLog;
  } = {
    warn: vi.fn(_noop),
    withTag: () => _fakeLog,
  };

  return {
    fakeLog: _fakeLog,
    mockListIssueAlertsPaginated: vi.fn(),
    mockListMetricAlertsPaginated: vi.fn(),
    noop: _noop,
  };
});

vi.mock("../../../src/lib/logger.js", () => ({
  logger: fakeLog,
  setLogLevel: vi.fn(noop),
  attachSentryReporter: vi.fn(noop),
}));

vi.mock("../../../src/lib/api-client.js", () => ({
  API_MAX_PER_PAGE: 100,
  getIssueAlertRule: vi.fn(),
  getMetricAlertRule: vi.fn(),
  isNotFoundApiError: vi.fn(() => false),
  listIssueAlertsPaginated: mockListIssueAlertsPaginated,
  listMetricAlertsPaginated: mockListMetricAlertsPaginated,
}));

import {
  listAllIssueRulesForTarget,
  parseIssueRuleArg,
} from "../../../src/commands/alert/issues/rule-resolve.js";
import {
  listAllMetricRulesForOrg,
  parseMetricRuleArg,
  resolveMetricAlertRule,
} from "../../../src/commands/alert/metrics/rule-resolve.js";
import { MAX_PAGINATION_PAGES } from "../../../src/lib/api/infrastructure.js";
import type {
  IssueAlertRule,
  MetricAlertRule,
} from "../../../src/lib/api-client.js";
import { ValidationError } from "../../../src/lib/errors.js";
import type { ResolvedTarget } from "../../../src/lib/resolve-target.js";

const HINT = "sentry alert <type> view <target>";
const TARGET: ResolvedTarget = {
  org: "test-org",
  project: "test-project",
  orgDisplay: "Test Org",
  projectDisplay: "Test Project",
};

beforeEach(() => {
  fakeLog.warn.mockClear();
  mockListIssueAlertsPaginated.mockReset();
  mockListMetricAlertsPaginated.mockReset();
});

function issueRule(id: string): IssueAlertRule {
  return {
    id,
    name: `Issue Rule ${id}`,
    status: "active",
    actionMatch: "any",
    conditions: [],
    actions: [],
    frequency: 30,
    environment: null,
    owner: null,
    projects: ["test-project"],
    dateCreated: "2026-01-01T00:00:00Z",
  };
}

function metricRule(id: string): MetricAlertRule {
  return {
    id,
    name: `Metric Rule ${id}`,
    status: 0,
    query: "",
    aggregate: "count()",
    dataset: "errors",
    timeWindow: 5,
    environment: null,
    owner: null,
    projects: ["test-project"],
    dateCreated: "2026-01-01T00:00:00Z",
  };
}

describe("parseIssueRuleArg", () => {
  test("empty string throws ValidationError", () => {
    expect(() => parseIssueRuleArg("", HINT)).toThrow(ValidationError);
  });

  test("bare name returns ref with no targetArg", () => {
    expect(parseIssueRuleArg("my-rule", HINT)).toEqual({
      ref: "my-rule",
      targetArg: undefined,
    });
  });

  test("bare numeric returns ref with no targetArg", () => {
    expect(parseIssueRuleArg("42", HINT)).toEqual({
      ref: "42",
      targetArg: undefined,
    });
  });

  test("single slash throws ValidationError (missing rule)", () => {
    expect(() => parseIssueRuleArg("org/project", HINT)).toThrow(
      ValidationError
    );
  });

  test("two slashes parses org/project and rule ref", () => {
    expect(parseIssueRuleArg("org/project/42", HINT)).toEqual({
      ref: "42",
      targetArg: "org/project",
    });
  });

  test("name with spaces after two slashes", () => {
    expect(parseIssueRuleArg("org/project/My Rule Name", HINT)).toEqual({
      ref: "My Rule Name",
      targetArg: "org/project",
    });
  });

  test("trailing slash after two slashes throws ValidationError", () => {
    expect(() => parseIssueRuleArg("org/project/", HINT)).toThrow(
      ValidationError
    );
  });

  test("whitespace is trimmed", () => {
    expect(parseIssueRuleArg("  org/project/42  ", HINT)).toEqual({
      ref: "42",
      targetArg: "org/project",
    });
  });
});

describe("parseMetricRuleArg", () => {
  test("empty string throws ValidationError", () => {
    expect(() => parseMetricRuleArg("", HINT)).toThrow(ValidationError);
  });

  test("bare name returns ref with no targetArg", () => {
    expect(parseMetricRuleArg("my-rule", HINT)).toEqual({
      ref: "my-rule",
      targetArg: undefined,
    });
  });

  test("single slash parses org and rule ref", () => {
    expect(parseMetricRuleArg("org/42", HINT)).toEqual({
      ref: "42",
      targetArg: "org/",
    });
  });

  test("single slash with name ref", () => {
    expect(parseMetricRuleArg("org/Rule Name", HINT)).toEqual({
      ref: "Rule Name",
      targetArg: "org/",
    });
  });

  test("trailing slash throws ValidationError (missing rule ref)", () => {
    expect(() => parseMetricRuleArg("org/", HINT)).toThrow(ValidationError);
  });

  test("bare org with slash but no ref throws", () => {
    expect(() => parseMetricRuleArg("my-org/", HINT)).toThrow(ValidationError);
  });

  test("two slashes (org/project/rule) throws — metric alerts are org-scoped", () => {
    expect(() => parseMetricRuleArg("org/project/42", HINT)).toThrow(
      ValidationError
    );
  });
});

describe("listAllIssueRulesForTarget", () => {
  test("fetches all pages without warning when the final page has no next cursor", async () => {
    mockListIssueAlertsPaginated
      .mockResolvedValueOnce({
        data: [issueRule("1")],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        data: [issueRule("2")],
        nextCursor: undefined,
      });

    const rules = await listAllIssueRulesForTarget(TARGET);

    expect(rules.map((rule) => rule.id)).toEqual(["1", "2"]);
    expect(mockListIssueAlertsPaginated).toHaveBeenCalledTimes(2);
    expect(mockListIssueAlertsPaginated).toHaveBeenNthCalledWith(
      1,
      "test-org",
      "test-project",
      { perPage: 100, cursor: undefined }
    );
    expect(mockListIssueAlertsPaginated).toHaveBeenNthCalledWith(
      2,
      "test-org",
      "test-project",
      { perPage: 100, cursor: "cursor-1" }
    );
    expect(fakeLog.warn).not.toHaveBeenCalled();
  });

  test("warns once when the safety page limit is exhausted", async () => {
    for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
      mockListIssueAlertsPaginated.mockResolvedValueOnce({
        data: [issueRule(String(page + 1))],
        nextCursor: `cursor-${page + 1}`,
      });
    }

    const rules = await listAllIssueRulesForTarget(TARGET);

    expect(rules).toHaveLength(MAX_PAGINATION_PAGES);
    expect(mockListIssueAlertsPaginated).toHaveBeenCalledTimes(
      MAX_PAGINATION_PAGES
    );
    expect(fakeLog.warn).toHaveBeenCalledTimes(1);
    expect(fakeLog.warn.mock.calls[0]?.[0]).toContain(
      "Pagination limit reached for issue alert rules in test-org/test-project."
    );
  });
});

describe("resolveMetricAlertRule name matching with null names", () => {
  const HINT_METRIC = "sentry alert metrics view <target>";

  test("resolves a named rule when a sibling rule has a null name", async () => {
    const namedRule = { ...metricRule("1"), name: "Prod Errors" };
    const nullNamed = {
      ...metricRule("2"),
      name: null,
    } as unknown as MetricAlertRule;
    mockListMetricAlertsPaginated.mockResolvedValueOnce({
      data: [nullNamed, namedRule],
      nextCursor: undefined,
    });

    const resolution = await resolveMetricAlertRule(
      ["test-org"],
      "Prod Errors",
      HINT_METRIC
    );

    expect(resolution.rule.id).toBe("1");
  });

  test("does not throw a TypeError when every rule name is null", async () => {
    const nullNamed = {
      ...metricRule("1"),
      name: null,
    } as unknown as MetricAlertRule;
    mockListMetricAlertsPaginated.mockResolvedValueOnce({
      data: [nullNamed],
      nextCursor: undefined,
    });

    // Null names are skipped, so the ref matches nothing and we get the
    // domain-level "not found" error rather than a TypeError on toLowerCase().
    await expect(
      resolveMetricAlertRule(["test-org"], "missing", HINT_METRIC)
    ).rejects.not.toThrow(TypeError);
  });
});

describe("listAllMetricRulesForOrg", () => {
  test("fetches all pages without warning when the final page has no next cursor", async () => {
    mockListMetricAlertsPaginated
      .mockResolvedValueOnce({
        data: [metricRule("1")],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        data: [metricRule("2")],
        nextCursor: undefined,
      });

    const rules = await listAllMetricRulesForOrg("test-org");

    expect(rules.map((rule) => rule.id)).toEqual(["1", "2"]);
    expect(mockListMetricAlertsPaginated).toHaveBeenCalledTimes(2);
    expect(mockListMetricAlertsPaginated).toHaveBeenNthCalledWith(
      1,
      "test-org",
      {
        perPage: 100,
        cursor: undefined,
      }
    );
    expect(mockListMetricAlertsPaginated).toHaveBeenNthCalledWith(
      2,
      "test-org",
      {
        perPage: 100,
        cursor: "cursor-1",
      }
    );
    expect(fakeLog.warn).not.toHaveBeenCalled();
  });

  test("warns once when the safety page limit is exhausted", async () => {
    for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
      mockListMetricAlertsPaginated.mockResolvedValueOnce({
        data: [metricRule(String(page + 1))],
        nextCursor: `cursor-${page + 1}`,
      });
    }

    const rules = await listAllMetricRulesForOrg("test-org");

    expect(rules).toHaveLength(MAX_PAGINATION_PAGES);
    expect(mockListMetricAlertsPaginated).toHaveBeenCalledTimes(
      MAX_PAGINATION_PAGES
    );
    expect(fakeLog.warn).toHaveBeenCalledTimes(1);
    expect(fakeLog.warn.mock.calls[0]?.[0]).toContain(
      "Pagination limit reached for metric alert rules in test-org."
    );
  });
});
