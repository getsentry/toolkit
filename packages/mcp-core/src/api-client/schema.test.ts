import {
  autofixStateExplorerFixture,
  createDefaultEvent,
  issueNullCulpritFixture,
  profileChunkFixture,
  tagsFixture,
  transactionProfileV1MissingFunctionFixture,
  transactionProfileV1Fixture,
} from "@sentry/mcp-server-mocks";
import { describe, expect, it } from "vitest";
import {
  AutofixRunSchema,
  AutofixRunStateSchema,
  ClientKeySchema,
  EventSchema,
  FlamegraphSchema,
  IssueSchema,
  IssueTagValuesSchema,
  ProfileChunkResponseSchema,
  ProfileChunkSampleSchema,
  ProfileChunkSchema,
  ProfileFrameSchema,
  ReleaseSchema,
  ReplayDetailsSchema,
  ReplayRecordingSegmentsSchema,
  TagSchema,
  TraceMetaSchema,
  TransactionProfileSampleSchema,
  TransactionProfileSchema,
} from "./schema";

describe("IssueSchema", () => {
  it("should parse a standard error issue", () => {
    const errorIssue = {
      id: "123456",
      shortId: "PROJECT-123",
      title: "TypeError: Cannot read property 'foo' of undefined",
      firstSeen: "2025-01-01T00:00:00Z",
      lastSeen: "2025-01-02T00:00:00Z",
      count: "42",
      userCount: 10,
      permalink: "https://sentry.io/issues/123456/",
      project: {
        id: "1",
        name: "test-project",
        slug: "test-project",
        platform: "javascript",
      },
      platform: "javascript",
      status: "unresolved",
      culprit: "app/components/Widget.js",
      type: "error",
      metadata: {
        title: "TypeError",
        value: "Cannot read property 'foo' of undefined",
      },
    };

    const result = IssueSchema.parse(errorIssue);
    expect(result).toEqual(errorIssue);
  });

  it("should parse a regressed performance issue", () => {
    // Anonymized payload from real regressed issue (issue #633)
    const regressedIssue = {
      id: "6898891101",
      shareId: null,
      shortId: "MCP-SERVER-EQE",
      title: "Endpoint Regression",
      culprit: "POST /oauth/token",
      permalink: "https://sentry.sentry.io/issues/6898891101/",
      logger: null,
      level: "info",
      status: "unresolved",
      statusDetails: {},
      substatus: "regressed", // Key field for regressed issues
      isPublic: false,
      platform: "python",
      project: {
        id: "4509062593708032",
        name: "mcp-server",
        slug: "mcp-server",
        platform: "node-cloudflare-workers",
      },
      type: "generic", // Performance issues use "generic" type
      metadata: {
        title: "Endpoint Regression",
        value: "Increased from 909.77ms to 1711.36ms (P95)",
        initial_priority: 50, // Additional field not in base schema
      },
      numComments: 0,
      assignedTo: null,
      isBookmarked: false,
      isSubscribed: false,
      subscriptionDetails: null,
      hasSeen: true,
      annotations: [],
      issueType: "performance_p95_endpoint_regression",
      issueCategory: "metric",
      priority: "medium",
      priorityLockedAt: null,
      seerFixabilityScore: 0.281737357378006,
      seerAutofixLastTriggered: "2025-09-24T03:02:31.724243Z",
      isUnhandled: false,
      count: "3",
      userCount: 0,
      firstSeen: "2025-09-24T03:02:10.919020Z",
      lastSeen: "2025-11-18T06:01:20Z",
      firstRelease: null,
      lastRelease: null,
      tags: [
        { key: "level", name: "Level", totalValues: 3 },
        { key: "transaction", name: "Transaction", totalValues: 3 },
      ],
      activity: [
        {
          id: "5393778915",
          user: null,
          sentry_app: null,
          type: "set_regression",
          data: {
            event_id: "a6251c18f0194b8e8158518b8ee99545",
            version: "",
          },
          dateCreated: "2025-11-18T06:01:22.267515Z",
        },
      ],
      seenBy: [],
      pluginActions: [],
      pluginIssues: [],
      pluginContexts: [],
      userReportCount: 0,
      stats: {
        "24h": [],
        "30d": [],
      },
      participants: [],
    };

    // This should not throw - if it does, the schema is too strict
    const result = IssueSchema.parse(regressedIssue);

    expect(result.shortId).toBe("MCP-SERVER-EQE");
    expect(result.type).toBe("generic");
    expect(result.issueType).toBe("performance_p95_endpoint_regression");
    expect(result.issueCategory).toBe("metric");
  });

  it("should parse a transaction issue", () => {
    const transactionIssue = {
      id: "789",
      shortId: "PERF-42",
      title: "Slow Database Query",
      firstSeen: "2025-01-01T00:00:00Z",
      lastSeen: "2025-01-02T00:00:00Z",
      count: 100,
      userCount: 25,
      permalink: "https://sentry.io/issues/789/",
      project: {
        id: "2",
        name: "backend",
        slug: "backend",
        platform: "python",
      },
      platform: "python",
      status: "unresolved",
      culprit: "api/queries.py",
      type: "transaction",
    };

    const result = IssueSchema.parse(transactionIssue);
    expect(result.type).toBe("transaction");
  });

  it("should handle issues with assignedTo as string", () => {
    const issue = {
      id: "999",
      shortId: "TEST-99",
      title: "Test Issue",
      firstSeen: "2025-01-01T00:00:00Z",
      lastSeen: "2025-01-02T00:00:00Z",
      count: 1,
      userCount: 1,
      permalink: "https://sentry.io/issues/999/",
      project: {
        id: "3",
        name: "test",
        slug: "test",
        platform: "node",
      },
      status: "unresolved",
      culprit: "test.js",
      type: "error",
      assignedTo: "user@example.com",
    };

    const result = IssueSchema.parse(issue);
    expect(result.assignedTo).toBe("user@example.com");
  });

  it("should handle issues with assignedTo as object", () => {
    const issue = {
      id: "888",
      shortId: "TEST-88",
      title: "Test Issue",
      firstSeen: "2025-01-01T00:00:00Z",
      lastSeen: "2025-01-02T00:00:00Z",
      count: 1,
      userCount: 1,
      permalink: "https://sentry.io/issues/888/",
      project: {
        id: "4",
        name: "test",
        slug: "test",
        platform: "node",
      },
      status: "unresolved",
      culprit: "test.js",
      type: "error",
      assignedTo: {
        type: "team",
        id: "123",
        name: "Backend Team",
      },
    };

    const result = IssueSchema.parse(issue);
    expect(result.assignedTo).toEqual({
      type: "team",
      id: "123",
      name: "Backend Team",
    });
  });

  it("should handle issues with null firstSeen and lastSeen", () => {
    // Sentry's API can return null for firstSeen/lastSeen in some cases
    // (e.g. issues with no events). Regression test for MCP-SERVER-EWN.
    const issue = {
      id: "777",
      shortId: "TEST-77",
      title: "Test Issue",
      firstSeen: null,
      lastSeen: null,
      count: 1,
      userCount: 1,
      permalink: "https://sentry.io/issues/777/",
      project: {
        id: "5",
        name: "test",
        slug: "test",
        platform: "node",
      },
      status: "unresolved",
      culprit: "test.js",
      type: "error",
    };

    const result = IssueSchema.parse(issue);
    expect(result.firstSeen).toBeNull();
    expect(result.lastSeen).toBeNull();
  });

  it("should handle issues with null culprit", () => {
    const result = IssueSchema.parse(issueNullCulpritFixture);
    expect(result.culprit).toBeNull();
  });
});

describe("EventSchema", () => {
  it("should parse a standard error event", () => {
    const errorEvent = {
      id: "abc123",
      title: "TypeError: Cannot read property 'x'",
      message: "Cannot read property 'x' of undefined",
      platform: "javascript",
      type: "error",
      entries: [
        {
          type: "exception",
          data: {
            values: [
              {
                type: "TypeError",
                value: "Cannot read property 'x' of undefined",
                stacktrace: {
                  frames: [],
                },
              },
            ],
          },
        },
      ],
      contexts: {},
      tags: [
        { key: "environment", value: "production" },
        { key: "level", value: "error" },
      ],
      culprit: "app.js",
      dateCreated: "2025-01-01T00:00:00Z",
    };

    const result = EventSchema.parse(errorEvent);
    expect(result.type).toBe("error");
  });

  it("should parse null dateReceived and null generic occurrence", () => {
    const genericEvent = {
      id: "2d9a3f30ee5a4a95b712e78b87631f9a",
      title: "Metric regression",
      message: null,
      platform: null,
      type: "generic",
      entries: [],
      dateCreated: "2025-01-01T00:00:00Z",
      dateReceived: null,
      occurrence: null,
    };

    const result = EventSchema.parse(genericEvent);
    expect(result.dateReceived).toBeNull();
    expect(result).toHaveProperty("occurrence", null);
  });

  it("should allow partially populated user geo payloads", () => {
    const errorEvent = {
      id: "geo123",
      title: "Geo Event",
      message: "geo payload includes nulls",
      platform: "javascript",
      type: "error",
      entries: [
        {
          type: "exception",
          data: {
            values: [
              {
                type: "Error",
                value: "geo payload includes nulls",
              },
            ],
          },
        },
      ],
      culprit: "app/geo.ts",
      dateCreated: "2025-01-01T00:00:00Z",
      tags: [],
      user: {
        ip_address: "127.0.0.1",
        geo: {
          country_code: "US",
          city: null,
          region: "United States",
        },
      },
    };

    const result = EventSchema.parse(errorEvent);
    expect(result.user?.geo).toEqual({
      country_code: "US",
      city: null,
      region: "United States",
    });
  });

  it("should parse a regressed performance event (generic type)", () => {
    // This is the actual event structure from a regressed performance issue
    const regressedEvent = {
      id: "a6251c18f0194b8e8158518b8ee99545",
      groupID: "6898891101",
      eventID: "a6251c18f0194b8e8158518b8ee99545",
      projectID: "4509062593708032",
      size: 547,
      entries: [], // Performance regression events have no entries
      dist: null,
      message: "",
      title: "Endpoint Regression",
      location: null,
      user: null,
      contexts: {},
      sdk: null,
      context: {},
      packages: {},
      type: "generic", // Key difference - performance issues use "generic" type
      metadata: {
        title: "Endpoint Regression",
      },
      tags: [
        { key: "level", value: "info" },
        { key: "transaction", value: "POST /oauth/token" },
      ],
      platform: "python",
      dateReceived: "2025-11-18T06:01:22.186680Z",
      errors: [],
      occurrence: {
        id: "ae3754a99b294006b8d13ad59bb84d0f",
        projectId: 4509062593708032,
        eventId: "a6251c18f0194b8e8158518b8ee99545",
        fingerprint: ["ddf744fc1a47831ed53d9a489160fa7a"],
        issueTitle: "Endpoint Regression",
        subtitle: "Increased from 909.77ms to 1711.36ms (P95)",
        resourceId: null,
        evidenceData: {
          absolutePercentageChange: 1.8810815660491678,
          aggregateRange1: 909.7721153846148,
          aggregateRange2: 1711.3555555555554,
          breakpoint: 1763416800,
          change: "regression",
          dataEnd: 1763488800,
          dataStart: 1762279200,
          project: "4509062593708032",
          requestEnd: 1763488800,
          requestStart: 1763229600,
          transaction: "POST /oauth/token",
          trendDifference: 801.5834401709405,
          trendPercentage: 1.8810815660491678,
          unweightedPValue: 0.0014395802,
          unweightedTValue: -4.5231295109262515,
        },
        evidenceDisplay: [
          {
            name: "Regression",
            value:
              "POST /oauth/token duration increased from 909.77ms to 1711.36ms (P95)",
            important: true,
          },
          {
            name: "Transaction",
            value: "POST /oauth/token",
            important: true,
          },
        ],
        type: 1018,
        detectionTime: 1763445680.827214,
        level: "info",
        culprit: "POST /oauth/token",
        priority: 50,
        assignee: null,
      },
      _meta: {
        entries: {},
        message: null,
        user: null,
        contexts: null,
        sdk: null,
        context: null,
        packages: null,
        tags: {},
      },
      crashFile: null,
      culprit: "POST /oauth/token",
      dateCreated: "2025-11-18T06:01:20Z",
      fingerprints: ["d41d8cd98f00b204e9800998ecf8427e"],
      groupingConfig: {
        id: "newstyle:2023-01-11",
        enhancements:
          "KLUv_SAd6QAAkwORuGFsbC1wbGF0Zm9ybXM6MjAyMy0wMS0xMZA#KLUv_SAd6QAAkwORuGFsbC1wbGF0Zm9ybXM6MjAyMy0wMS0xMZA#KLUv_SAd6QAAkwORuGFsbC1wbGF0Zm9ybXM6MjAyMy0wMS0xMZA",
      },
      release: null,
      userReport: null,
      sdkUpdates: [],
      resolvedWith: [],
      nextEventID: null,
      previousEventID: "65d7c166833945efad0a4d38a4fd3665",
    };

    // This should not throw - the UnknownEventSchema should handle "generic" type
    const result = EventSchema.parse(regressedEvent);

    expect(result.type).toBe("generic");
    expect(result.title).toBe("Endpoint Regression");
  });

  it("should parse a transaction event", () => {
    const transactionEvent = {
      id: "xyz789",
      title: "GET /api/users",
      message: null,
      platform: "python",
      type: "transaction",
      entries: [],
      contexts: {
        trace: {
          type: "trace",
          trace_id: "abc123",
        },
      },
      tags: [{ key: "transaction", value: "GET /api/users" }],
      occurrence: null,
    };

    const result = EventSchema.parse(transactionEvent);
    expect(result.type).toBe("transaction");
  });

  it("should ignore malformed tags with null keys", () => {
    const eventWithMalformedTag = {
      id: "abc123",
      title: "TypeError: Cannot read property 'x'",
      message: "Cannot read property 'x' of undefined",
      platform: "javascript",
      type: "error",
      entries: [],
      contexts: {},
      tags: [
        { key: null, value: "production" },
        { key: "level", value: "error" },
      ],
      culprit: "app.js",
      dateCreated: "2025-01-01T00:00:00Z",
    };

    const result = EventSchema.parse(eventWithMalformedTag);
    expect(result.tags).toEqual([{ key: "level", value: "error" }]);
  });
});

describe("ReplayDetailsSchema", () => {
  it("normalizes archived replay payloads that use empty-list tags and null URLs", () => {
    const replay = ReplayDetailsSchema.parse({
      id: "7aa244144fa44d26813dbe157af9de13",
      project_id: "1",
      trace_ids: [],
      error_ids: [],
      info_ids: [],
      warning_ids: [],
      environment: null,
      tags: [],
      user: {
        id: "Archived Replay",
        display_name: "Archived Replay",
        username: null,
        email: null,
        ip: null,
        geo: {
          city: null,
          country_code: null,
          region: null,
          subdivision: null,
        },
      },
      sdk: { name: null, version: null },
      os: { name: null, version: null },
      browser: { name: null, version: null },
      device: { name: null, brand: null, model: null, family: null },
      urls: null,
      is_archived: true,
      releases: [],
      replay_type: "session",
      has_viewed: false,
    });

    expect(replay.tags).toEqual({});
    expect(replay.urls).toEqual([]);
    expect(replay.user?.geo).toEqual({
      city: null,
      country_code: null,
      region: null,
      subdivision: null,
    });
  });
});

describe("ReplayRecordingSegmentsSchema", () => {
  it("keeps usable event fields when sibling fields are malformed", () => {
    expect(
      ReplayRecordingSegmentsSchema.parse([
        [
          {
            timestamp: "invalid",
            type: 5,
            data: {
              tag: "ui.click",
              href: 123,
              payload: {
                message: "Clicked checkout",
                data: { duration: "invalid" },
              },
            },
          },
        ],
      ]),
    ).toEqual([
      [
        {
          timestamp: undefined,
          type: 5,
          data: {
            tag: "ui.click",
            href: undefined,
            payload: {
              message: "Clicked checkout",
              data: { duration: undefined },
            },
          },
        },
      ],
    ]);
  });
});

describe("ClientKeySchema", () => {
  it("accepts null dateCreated from upstream project keys", () => {
    const clientKey = ClientKeySchema.parse({
      id: "public-key",
      name: "Default",
      isActive: true,
      dateCreated: null,
      dsn: {
        public: "https://public@example.ingest.sentry.io/1",
      },
    });

    expect(clientKey.dateCreated).toBeNull();
  });
});

describe("ReleaseSchema", () => {
  it("accepts nullable commit, deploy, and project fields from upstream releases", () => {
    const release = ReleaseSchema.parse({
      id: "1",
      version: "1.2.3",
      shortVersion: "1.2.3",
      dateCreated: "2026-04-13T12:00:00.000Z",
      dateReleased: null,
      firstEvent: null,
      lastEvent: null,
      newGroups: 0,
      lastCommit: {
        id: "abc123",
        message: null,
        dateCreated: "2026-04-13T12:00:00.000Z",
        author: {},
      },
      lastDeploy: {
        id: "99",
        environment: null,
        dateStarted: null,
        dateFinished: null,
      },
      projects: [
        {
          id: "1",
          slug: null,
          name: "project-one",
          platform: "javascript",
        },
      ],
    });

    expect(release.lastCommit?.message).toBeNull();
    expect(release.lastCommit?.author).toEqual({});
    expect(release.lastDeploy?.environment).toBeNull();
    expect(release.projects[0]?.slug).toBeNull();
  });
});

describe("TagSchema", () => {
  it("normalizes upstream tag counts when only uniqueValues is present", () => {
    const tag = TagSchema.parse(tagsFixture[0]);

    expect(tag).toEqual({
      key: "transaction",
      name: "Transaction",
      totalValues: 1080,
    });
  });
});

describe("TraceMetaSchema", () => {
  it("defaults missing trace metadata counts and maps", () => {
    expect(TraceMetaSchema.parse({})).toEqual({
      logs: 0,
      errors: 0,
      performance_issues: 0,
      span_count: 0,
      transaction_child_count_map: [],
      span_count_map: {},
    });
  });

  it("normalizes current trace-meta response keys", () => {
    expect(
      TraceMetaSchema.parse({
        logsCount: 3,
        errorsCount: 2,
        performanceIssuesCount: 1,
        spansCount: 4,
        transactionChildCountMap: [
          {
            "transaction.event_id": "0daf40dc453a429c8c57e4c215c4e82c",
            "count()": 4,
          },
        ],
        spansCountMap: {
          "http.client": 4,
        },
      }),
    ).toEqual({
      logs: 3,
      errors: 2,
      performance_issues: 1,
      span_count: 4,
      transaction_child_count_map: [
        {
          "transaction.event_id": "0daf40dc453a429c8c57e4c215c4e82c",
          "count()": 4,
        },
      ],
      span_count_map: {
        "http.client": 4,
      },
    });
  });
});

describe("AutofixRunSchema", () => {
  it("accepts the numeric run_id returned by the autofix POST endpoint", () => {
    const run = AutofixRunSchema.parse({ run_id: 123 });

    expect(run.run_id).toBe(123);
  });
});

describe("AutofixRunStateSchema", () => {
  it("accepts agent-based autofix state without legacy steps", () => {
    const state = AutofixRunStateSchema.parse(autofixStateExplorerFixture);

    expect(state.autofix?.status).toBe("processing");
    expect(state.autofix?.blocks).toHaveLength(1);
    expect(state.autofix?.blocks[0].todos).toEqual([
      { content: "Investigate failing request", status: "completed" },
      { content: "Draft fix plan", status: "in_progress" },
    ]);
  });
});

describe("IssueTagValuesSchema", () => {
  it("normalizes aggregate counts and missing topValues from upstream tag details", () => {
    const tagValues = IssueTagValuesSchema.parse({
      key: "release",
      name: "Release",
      uniqueValues: 3,
    });

    expect(tagValues).toEqual({
      key: "release",
      name: "Release",
      totalValues: 3,
      topValues: [],
    });
  });

  it("normalizes nullable tag value counts to zero", () => {
    const tagValues = IssueTagValuesSchema.parse({
      key: "user",
      name: "User",
      totalValues: 1,
      topValues: [
        {
          key: "user",
          name: null,
          value: null,
          count: null,
          firstSeen: null,
          lastSeen: null,
        },
      ],
    });

    expect(tagValues.topValues[0]?.count).toBe(0);
  });
});

describe("FlamegraphSchema", () => {
  it("fills optional profiling fields that Sentry omits or returns as null", () => {
    const flamegraph = FlamegraphSchema.parse({
      metadata: {
        profileID: "profile-1",
      },
      platform: "python",
      profiles: [
        {
          endValue: 0,
          isMainThread: true,
          name: "Main Thread",
          samples: [],
          startValue: 0,
          threadID: 1,
          type: "sampled",
          unit: "count",
          weights: [],
          sample_durations_ns: null,
        },
      ],
      projectID: 1,
      shared: {
        frames: [],
      },
      transactionName: "POST /oauth/token",
    });

    expect(flamegraph.activeProfileIndex).toBe(0);
    expect(flamegraph.shared.frame_infos).toEqual([]);
    expect(flamegraph.shared.profiles).toEqual([]);
    expect(flamegraph.profiles[0]?.sample_durations_ns).toEqual([]);
    expect(flamegraph.profiles[0]?.sample_counts).toEqual([]);
  });

  it("parses sparse empty flamegraph responses so tools can return no-data output", () => {
    const flamegraph = FlamegraphSchema.parse({
      metadata: {
        platform: "javascript",
        projectID: 1,
        transactionName: "POST /checkout",
      },
    });

    expect(flamegraph.platform).toBe("javascript");
    expect(flamegraph.projectID).toBe(1);
    expect(flamegraph.transactionName).toBe("POST /checkout");
    expect(flamegraph.profiles).toEqual([]);
    expect(flamegraph.shared.frames).toEqual([]);
    expect(flamegraph.shared.frame_infos).toEqual([]);
    expect(flamegraph.shared.profiles).toEqual([]);
  });

  it("parses continuous profile references returned in aggregate flamegraphs", () => {
    const flamegraph = FlamegraphSchema.parse({
      platform: "javascript",
      projectID: 1,
      profiles: [],
      shared: {
        frames: [],
        profiles: [
          {
            project_id: 1,
            profiler_id: "041bde57b9844e36b8b7e5734efae5f7",
            chunk_id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
            thread_id: "12345",
            start: "1710958503629000000",
            end: "1710958504629000000",
            transaction_id: null,
          },
        ],
      },
    });

    expect(flamegraph.shared.profiles).toHaveLength(1);
    expect(flamegraph.shared.profiles[0]).toMatchObject({
      project_id: 1,
      profiler_id: "041bde57b9844e36b8b7e5734efae5f7",
      chunk_id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
      thread_id: "12345",
      start: "1710958503629000000",
      end: "1710958504629000000",
      transaction_id: null,
    });
  });

  it("parses fallback continuous profile references without optional timing or thread fields", () => {
    const flamegraph = FlamegraphSchema.parse({
      platform: "javascript",
      projectID: 1,
      profiles: [],
      shared: {
        frames: [],
        profiles: [
          {
            project_id: 1,
            profiler_id: "041bde57b9844e36b8b7e5734efae5f7",
            chunk_id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
          },
        ],
      },
    });

    expect(flamegraph.shared.profiles).toHaveLength(1);
    expect(flamegraph.shared.profiles[0]).toMatchObject({
      project_id: 1,
      profiler_id: "041bde57b9844e36b8b7e5734efae5f7",
      chunk_id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    });
  });

  it("parses upstream frame infos without weight and string profile references", () => {
    const flamegraph = FlamegraphSchema.parse({
      platform: "javascript",
      projectID: 1,
      profiles: [],
      shared: {
        frames: [],
        frame_infos: [
          {
            count: 3,
            sumDuration: 42,
            sumSelfTime: 12,
            p75Duration: 20,
            p95Duration: 30,
            p99Duration: 40,
          },
        ],
        profiles: ["transaction-profile-id"],
      },
    });

    expect(flamegraph.shared.frame_infos[0]?.weight).toBe(42);
    expect(flamegraph.shared.profiles[0]).toBe("transaction-profile-id");
  });
});

describe("ProfileChunkSampleSchema", () => {
  it("parses V2 continuous profile chunk samples with string thread_id and timestamp", () => {
    const sample = ProfileChunkSampleSchema.parse({
      stack_id: 0,
      thread_id: "1",
      timestamp: 1710958503.629,
    });

    expect(sample.thread_id).toBe("1");
    expect(sample.timestamp).toBe(1710958503.629);
  });

  it("rejects V1-only fields and shapes that don't match the V2 wire format", () => {
    // V2 samples must have a string thread_id (not uint64) and a required
    // timestamp. Keeping this strict prevents V1 payloads from silently
    // parsing as V2 and vice-versa.
    expect(() =>
      ProfileChunkSampleSchema.parse({
        stack_id: 0,
        thread_id: 1,
        timestamp: 1710958503.629,
      }),
    ).toThrow();
    expect(() =>
      ProfileChunkSampleSchema.parse({
        stack_id: 0,
        thread_id: "1",
        elapsed_since_start_ns: 50000000,
      }),
    ).toThrow();
  });
});

describe("TransactionProfileSampleSchema", () => {
  it("parses V1 transaction profile samples with numeric thread_id and elapsed_since_start_ns", () => {
    // Regression test for getsentry/sentry-mcp issue MCP-SERVER-FRN: vroom
    // serializes V1 Sample.ThreadID as uint64 and uses elapsed_since_start_ns
    // rather than timestamp.
    const sample = TransactionProfileSampleSchema.parse({
      stack_id: 0,
      thread_id: 1,
      elapsed_since_start_ns: 50000000,
    });

    expect(sample.thread_id).toBe("1");
    expect(sample.elapsed_since_start_ns).toBe(50000000);
  });

  it("still normalizes V1 payloads that already carry a string thread_id", () => {
    const sample = TransactionProfileSampleSchema.parse({
      stack_id: 0,
      thread_id: "1",
      elapsed_since_start_ns: 1_000_000,
    });

    expect(sample.thread_id).toBe("1");
    expect(sample.elapsed_since_start_ns).toBe(1_000_000);
  });

  it("rejects V1 samples that are missing the required elapsed_since_start_ns", () => {
    // vroom always emits Sample.ElapsedSinceStartNS for V1 transaction
    // profiles, so make that a hard requirement rather than silently accepting
    // a V2-shaped payload on the V1 path.
    expect(() =>
      TransactionProfileSampleSchema.parse({
        stack_id: 0,
        thread_id: "1",
        timestamp: 1710958503.629,
      }),
    ).toThrow();
  });
});

describe("ProfileFrameSchema", () => {
  it("accepts sampled profile frames without a function name", () => {
    // Sentry's sampled profile frame contract treats function as optional:
    // static/app/types/profiling.d.ts defines `function?: string`, and the
    // profile processing pipeline falls back when it is missing.
    const frame = ProfileFrameSchema.parse({
      filename: "main.py",
      in_app: true,
      lineno: 42,
    });

    expect(frame.function).toBeUndefined();
    expect(frame.in_app).toBe(true);
  });
});

describe("profile fixtures", () => {
  it("parses the V1 transaction profile fixture through TransactionProfileSchema", () => {
    // transaction-profile-v1.json mirrors what vroom emits for legacy/V1
    // transaction profiles: numeric uint64 thread_id, elapsed_since_start_ns
    // timing, and a required transaction block with active_thread_id.
    const profile = TransactionProfileSchema.parse(
      structuredClone(transactionProfileV1Fixture),
    );

    expect(profile.transaction?.active_thread_id).toBeTypeOf("string");
    expect(
      profile.profile.samples.every(
        (sample) => typeof sample.thread_id === "string",
      ),
    ).toBe(true);
    expect(
      profile.profile.samples.some(
        (sample) => typeof sample.elapsed_since_start_ns === "number",
      ),
    ).toBe(true);
  });

  it("parses the V2 continuous profile chunk fixture through ProfileChunkSchema", () => {
    // profile-chunk.json mirrors the continuous profiler output: string
    // thread_id, absolute timestamp per sample, no transaction block.
    const chunk = ProfileChunkSchema.parse(
      structuredClone(profileChunkFixture.chunk),
    );

    expect(
      chunk.profile.samples.every(
        (sample) => typeof sample.thread_id === "string",
      ),
    ).toBe(true);
    expect(
      chunk.profile.samples.every(
        (sample) => typeof sample.timestamp === "number",
      ),
    ).toBe(true);
  });

  it("parses continuous profile thread metadata entries without names", () => {
    const chunk = ProfileChunkSchema.parse({
      ...structuredClone(profileChunkFixture.chunk),
      profile: {
        ...structuredClone(profileChunkFixture.chunk.profile),
        thread_metadata: {
          "1": { priority: 10 },
        },
      },
    });

    expect(chunk.profile.thread_metadata["1"]?.priority).toBe(10);
  });

  it("parses Sentry's singular profile chunk response wrapper", () => {
    const response = ProfileChunkResponseSchema.parse(
      structuredClone(profileChunkFixture),
    );

    expect(response.chunks).toHaveLength(1);
    expect(response.chunks[0]?.chunk_id).toBe(
      profileChunkFixture.chunk.chunk_id,
    );
  });

  it("still parses the legacy plural profile chunk response wrapper", () => {
    const response = ProfileChunkResponseSchema.parse({
      chunks: [structuredClone(profileChunkFixture.chunk)],
    });

    expect(response.chunks).toHaveLength(1);
    expect(response.chunks[0]?.chunk_id).toBe(
      profileChunkFixture.chunk.chunk_id,
    );
  });
});

describe("TransactionProfileSchema", () => {
  it("parses V1 transaction profiles with numeric active_thread_id and uint64 sample thread ids", () => {
    // Regression test for getsentry/sentry-mcp issue MCP-SERVER-FRN.
    const profile = TransactionProfileSchema.parse({
      event_id: "cfe78a5c892d4a64a962d837673398d2",
      profile_id: "cfe78a5c892d4a64a962d837673398d2",
      platform: "python",
      version: "2",
      profile: {
        frames: [{ function: "handle_request", in_app: true }],
        samples: [
          { stack_id: 0, thread_id: 1, elapsed_since_start_ns: 0 },
          { stack_id: 0, thread_id: 1, elapsed_since_start_ns: 50000000 },
        ],
        stacks: [[0]],
        thread_metadata: { "1": { name: "MainThread" } },
      },
      transaction: {
        name: "/api/users",
        trace_id: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        id: "7ca573c0f4814912aaa9bdc77d1a7d51",
        active_thread_id: 1,
      },
    });

    expect(profile.transaction?.active_thread_id).toBe("1");
    expect(profile.profile.samples[0]?.thread_id).toBe("1");
    expect(profile.profile.samples[0]?.elapsed_since_start_ns).toBe(0);
  });

  it("accepts V1 transaction profiles when some frames omit function", () => {
    const parsed = TransactionProfileSchema.parse(
      structuredClone(transactionProfileV1MissingFunctionFixture),
    );

    expect(parsed.profile.frames[0]?.function).toBeUndefined();
  });

  it("defaults omitted thread_metadata to an empty object", () => {
    // Sentry's SentrySampledProfile type marks thread_metadata optional, and
    // the project profiling endpoint proxies the profiling-service payload
    // without normalizing it. Regression coverage for MCP-SERVER-FSD.
    const profile = TransactionProfileSchema.parse({
      event_id: "cfe78a5c892d4a64a962d837673398d2",
      profile_id: "cfe78a5c892d4a64a962d837673398d2",
      platform: "python",
      version: "2",
      profile: {
        frames: [{ function: "handle_request", in_app: true }],
        samples: [{ stack_id: 0, thread_id: 1, elapsed_since_start_ns: 0 }],
        stacks: [[0]],
      },
      transaction: {
        name: "/api/users",
        trace_id: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        id: "7ca573c0f4814912aaa9bdc77d1a7d51",
        active_thread_id: 1,
      },
    });

    expect(profile.profile.thread_metadata).toEqual({});
  });

  it("defaults null thread_metadata to an empty object", () => {
    // Observed V1 payloads can send null even though the frontend type only
    // marks the field optional. Match ProfileChunkSchema's null-coalesce.
    const profile = TransactionProfileSchema.parse({
      event_id: "cfe78a5c892d4a64a962d837673398d2",
      profile_id: "cfe78a5c892d4a64a962d837673398d2",
      platform: "python",
      version: "2",
      profile: {
        frames: [{ function: "handle_request", in_app: true }],
        samples: [{ stack_id: 0, thread_id: 1, elapsed_since_start_ns: 0 }],
        stacks: [[0]],
        thread_metadata: null,
      },
      transaction: {
        name: "/api/users",
        trace_id: "a4d1aae7216b47ff8117cf4e09ce9d0a",
        id: "7ca573c0f4814912aaa9bdc77d1a7d51",
        active_thread_id: 1,
      },
    });

    expect(profile.profile.thread_metadata).toEqual({});
  });
});

describe("event packages", () => {
  it.each([
    { label: "missing", packages: undefined },
    { label: "null", packages: null },
    { label: "empty", packages: {} },
    { label: "recorded", packages: { example: "1.2.3", redacted: null } },
  ])("retains $label package metadata during event parsing", ({ packages }) => {
    const event = EventSchema.parse({ ...createDefaultEvent(), packages });
    expect(event.packages).toEqual(packages);
  });
});
