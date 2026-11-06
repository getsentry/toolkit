import { createDefaultEvent, mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getServerContext } from "../../test-setup.js";
import {
  type EventStacktracePayload,
  eventStacktraceOutputSchema,
} from "../support/event-stacktrace.js";
import getEventStacktrace from "./get-event-stacktrace.js";

const testIssue = {
  id: "6507376925",
  shortId: "THREADS-1",
  project: {
    id: "4509062593708032",
    slug: "cloudflare-mcp",
    name: "CLOUDFLARE-MCP",
  },
};

const eventWithThreads = createDefaultEvent({
  id: "event-with-threads",
  title: "Application crashed",
  message: "Application crashed",
  platform: "java",
  type: "error",
  entries: [
    {
      type: "message",
      data: {
        formatted: "Application crashed",
      },
    },
    {
      type: "threads",
      data: {
        values: [
          {
            id: 11,
            name: "worker",
            state: "WAITING",
            crashed: false,
            current: false,
            stacktrace: {
              frames: [
                {
                  filename: "Worker.java",
                  module: "com.example.Worker",
                  function: "waitForJob",
                  lineNo: 12,
                },
              ],
              framesOmitted: [10, 510],
              hasSystemFrames: false,
            },
          },
          {
            id: 259,
            name: "main",
            state: "RUNNABLE",
            crashed: true,
            current: true,
            stacktrace: {
              frames: [
                {
                  filename: "Thread.java",
                  absPath: "Thread.java",
                  module: "java.lang.Thread",
                  package: null,
                  platform: null,
                  instructionAddr: null,
                  symbolAddr: null,
                  function: "run",
                  rawFunction: null,
                  symbol: null,
                  context: [],
                  lineNo: 833,
                  colNo: null,
                  inApp: false,
                  trust: null,
                  errors: null,
                  lock: null,
                  sourceLink: null,
                  vars: null,
                },
                {
                  filename: "CheckoutActivity.java",
                  absPath: "CheckoutActivity.java",
                  module: "com.example.CheckoutActivity",
                  package: null,
                  platform: null,
                  instructionAddr: null,
                  symbolAddr: null,
                  function: "submitOrder",
                  rawFunction: null,
                  symbol: null,
                  lineNo: 42,
                  colNo: null,
                  inApp: true,
                  trust: null,
                  errors: null,
                  lock: null,
                  sourceLink: null,
                  vars: { userEmail: "jane@example.com", cartSize: 3 },
                  context: [
                    [40, "        Order order = buildOrder();"],
                    [41, "        if (order == null) {"],
                    [42, "            throw new IllegalStateException();"],
                    [43, "        }"],
                  ],
                },
              ],
              hasSystemFrames: true,
            },
          },
          {
            id: 300,
            name: "no-stack",
            state: "SLEEPING",
            crashed: false,
            current: false,
            stacktrace: null,
          },
        ],
      },
    },
  ],
});

function setupThreadMocks(event = eventWithThreads) {
  mswServer.use(
    http.get(
      "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/THREADS-1/",
      () => HttpResponse.json(testIssue),
    ),
    http.get(
      "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/THREADS-1/events/latest/",
      () => HttpResponse.json(event),
    ),
  );
}

async function callHandler(
  overrides: Partial<Parameters<typeof getEventStacktrace.handler>[0]> = {},
): Promise<EventStacktracePayload> {
  const result = await getEventStacktrace.handler(
    {
      organizationSlug: "sentry-mcp-evals",
      issueId: "THREADS-1",
      eventId: "latest",
      regionUrl: null,
      thread: undefined,
      ...overrides,
    },
    getServerContext(),
  );
  return eventStacktraceOutputSchema.parse(result.structuredContent);
}

describe("get_event_stacktrace", () => {
  it("returns Sentry's default selected thread stacktrace", async () => {
    setupThreadMocks();

    const result = await callHandler();

    expect(result).toMatchInlineSnapshot(`
      {
        "availableThreads": null,
        "eventId": "event-with-threads",
        "issueId": "THREADS-1",
        "organizationSlug": "sentry-mcp-evals",
        "platform": "java",
        "selection": {
          "message": "Sentry default selection: first crashed thread, then first thread with a stacktrace, then first thread.",
          "status": "selected",
        },
        "thread": {
          "crashed": true,
          "current": true,
          "frameCount": 2,
          "id": 259,
          "name": "main",
          "stacktrace": {
            "frames": [
              {
                "absPath": "Thread.java",
                "colNo": null,
                "contextLine": null,
                "filename": "Thread.java",
                "function": "run",
                "inApp": false,
                "lineNo": 833,
                "module": "java.lang.Thread",
                "package": null,
                "postContext": null,
                "preContext": null,
                "vars": null,
              },
              {
                "absPath": "CheckoutActivity.java",
                "colNo": null,
                "contextLine": "            throw new IllegalStateException();",
                "filename": "CheckoutActivity.java",
                "function": "submitOrder",
                "inApp": true,
                "lineNo": 42,
                "module": "com.example.CheckoutActivity",
                "package": null,
                "postContext": [
                  "        }",
                ],
                "preContext": [
                  "        Order order = buildOrder();",
                  "        if (order == null) {",
                ],
                "vars": {
                  "cartSize": 3,
                  "userEmail": "jane@example.com",
                },
              },
            ],
            "framesOmitted": null,
          },
          "state": "RUNNABLE",
        },
        "threadCount": 3,
      }
    `);
  });

  it("selects a thread by numeric ID", async () => {
    setupThreadMocks();

    const result = await callHandler({ thread: 11 });

    expect(result.selection).toEqual({
      status: "selected",
      message: "Matched the provided thread selector.",
    });
    expect(result.thread?.id).toBe(11);
    expect(result.thread?.stacktrace?.framesOmitted).toBe(500);
    expect(result.thread?.stacktrace?.frames).toEqual([
      expect.objectContaining({
        module: "com.example.Worker",
        function: "waitForJob",
        filename: "Worker.java",
        lineNo: 12,
      }),
    ]);
  });

  it("handles nullable stacktrace metadata from Sentry", async () => {
    setupThreadMocks(
      createDefaultEvent({
        id: "event-with-null-stacktrace-metadata",
        platform: "java",
        entries: [
          {
            type: "threads",
            data: {
              values: [
                {
                  id: 20,
                  name: "main",
                  crashed: true,
                  stacktrace: {
                    frames: [
                      {
                        filename: "Worker.java",
                        module: "com.example.Worker",
                        function: "run",
                        lineNo: 42,
                      },
                    ],
                    framesOmitted: null,
                    hasSystemFrames: null,
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const result = await callHandler();

    expect(result.thread?.id).toBe(20);
    expect(result.thread?.stacktrace).toEqual({
      frames: [
        expect.objectContaining({ function: "run", lineNo: 42, inApp: null }),
      ],
      framesOmitted: null,
    });
  });

  it("falls back to the first thread with frames when no thread crashed", async () => {
    setupThreadMocks(
      createDefaultEvent({
        id: "event-with-empty-stacktrace",
        platform: "java",
        entries: [
          {
            type: "threads",
            data: {
              values: [
                {
                  id: 10,
                  name: "empty",
                  crashed: false,
                  stacktrace: {
                    frames: [],
                  },
                },
                {
                  id: 20,
                  name: "usable",
                  crashed: false,
                  stacktrace: {
                    frames: [
                      {
                        filename: "Worker.java",
                        module: "com.example.Worker",
                        function: "run",
                        lineNo: 42,
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const result = await callHandler();

    expect(result.thread).toMatchObject({ id: 20, name: "usable" });
    expect(result.thread?.stacktrace?.frames[0]).toMatchObject({
      module: "com.example.Worker",
      function: "run",
      lineNo: 42,
    });
  });

  it("selects a thread by exact name", async () => {
    setupThreadMocks();

    const result = await callHandler({ thread: "main" });

    expect(result.thread).toMatchObject({ id: 259, name: "main" });
  });

  it("reports available threads when the selector does not match", async () => {
    setupThreadMocks();

    const result = await callHandler({ thread: "missing" });

    expect(result).toMatchInlineSnapshot(`
      {
        "availableThreads": [
          {
            "crashed": false,
            "current": false,
            "frameCount": 1,
            "id": 11,
            "name": "worker",
            "state": "WAITING",
          },
          {
            "crashed": true,
            "current": true,
            "frameCount": 2,
            "id": 259,
            "name": "main",
            "state": "RUNNABLE",
          },
          {
            "crashed": false,
            "current": false,
            "frameCount": 0,
            "id": 300,
            "name": "no-stack",
            "state": "SLEEPING",
          },
        ],
        "eventId": "event-with-threads",
        "issueId": "THREADS-1",
        "organizationSlug": "sentry-mcp-evals",
        "platform": "java",
        "selection": {
          "message": "No thread found with name "missing". Pass \`thread\` as a numeric thread id or exact thread name.",
          "status": "not_found",
        },
        "thread": null,
        "threadCount": 3,
      }
    `);
  });

  it("reports ambiguous thread names", async () => {
    setupThreadMocks(
      createDefaultEvent({
        id: "event-with-duplicate-names",
        platform: "python",
        entries: [
          {
            type: "threads",
            data: {
              values: [
                { id: 1, name: "worker", crashed: false, current: false },
                { id: 2, name: "worker", crashed: true, current: true },
              ],
            },
          },
        ],
      }),
    );

    const result = await callHandler({ thread: "worker" });

    expect(result.selection).toEqual({
      status: "ambiguous",
      message:
        'Multiple threads matched name "worker". Pass `thread` as a numeric thread id or exact thread name.',
    });
    expect(result.thread).toBeNull();
    expect(result.availableThreads?.map((thread) => thread.id)).toEqual([1, 2]);
  });

  it("reports events without threads", async () => {
    setupThreadMocks(
      createDefaultEvent({ id: "event-without-threads", entries: [] }),
    );

    const result = await callHandler();

    expect(result).toMatchObject({
      eventId: "event-without-threads",
      threadCount: 0,
      selection: { status: "no_threads" },
      thread: null,
      availableThreads: null,
    });
  });

  it("keeps raw addresses, symbols, locks and raw stacktraces out", async () => {
    setupThreadMocks(
      createDefaultEvent({
        id: "native-event",
        platform: "native",
        entries: [
          {
            type: "threads",
            data: {
              values: [
                {
                  id: 1,
                  name: "",
                  state: null,
                  crashed: true,
                  current: true,
                  heldLocks: {
                    "0x0d3a2f0a": {
                      type: 8,
                      address: "0x0d3a2f0a",
                      package_name: "java.lang",
                      class_name: "Object",
                      thread_id: 11,
                    },
                  },
                  stacktrace: {
                    frames: [
                      {
                        filename: "",
                        absPath: "/usr/src/app/crash.cpp",
                        module: null,
                        package: "/usr/lib/libapp.so",
                        platform: "native",
                        instructionAddr: "0x7f1c2b3a4d5e",
                        symbolAddr: "0x7f1c2b3a4d00",
                        function: "crash_handler",
                        rawFunction: "crash_handler(int)",
                        symbol: "_Z13crash_handleri",
                        context: [[17, "  *ptr = 0;"]],
                        lineNo: 17,
                        colNo: 5,
                        inApp: true,
                        trust: "context",
                        errors: null,
                        lock: null,
                        sourceLink:
                          "https://github.com/acme/app/blob/abc123/crash.cpp#L17",
                        vars: {},
                      },
                    ],
                    framesOmitted: null,
                    registers: { rip: "0x7f1c2b3a4d5e", rsp: "0x7ffd5c0e8a10" },
                    hasSystemFrames: false,
                  },
                  rawStacktrace: {
                    frames: [{ instructionAddr: "0x7f1c2b3a4d5e" }],
                    framesOmitted: null,
                    registers: null,
                    hasSystemFrames: false,
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const result = await callHandler();
    const serialized = JSON.stringify(result);

    expect(result.thread?.name).toBeNull();
    expect(result.thread?.stacktrace?.frames[0]).toEqual({
      filename: null,
      absPath: "/usr/src/app/crash.cpp",
      module: null,
      package: "/usr/lib/libapp.so",
      function: "crash_handler",
      lineNo: 17,
      colNo: 5,
      inApp: true,
      contextLine: "  *ptr = 0;",
      preContext: null,
      postContext: null,
      vars: null,
    });
    for (const leaked of [
      "0x7f1c2b3a4d5e",
      "0x7f1c2b3a4d00",
      "_Z13crash_handleri",
      "0x0d3a2f0a",
      "0x7ffd5c0e8a10",
      "github.com/acme",
      "rawStacktrace",
      "heldLocks",
      "registers",
      "trust",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });
});
