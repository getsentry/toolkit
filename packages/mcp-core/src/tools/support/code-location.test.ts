import { createDefaultEvent } from "@sentry/mcp-server-mocks";
import { describe, expect, it, vi } from "vitest";
import {
  ApiPermissionError,
  ApiServerError,
  type SentryApiService,
} from "../../api-client";
import type { Event } from "../../api-client/types";

const logging = vi.hoisted(() => ({
  logIssue: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../../telem/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../telem/logging")>()),
  logIssue: logging.logIssue,
  logWarn: logging.logWarn,
}));
import { resolveCodeLocation } from "./code-location";

function mockStacktraceLink() {
  return vi.fn<SentryApiService["getStacktraceLink"]>();
}

function resolve(
  event: Event,
  getStacktraceLink: ReturnType<typeof mockStacktraceLink>,
) {
  return resolveCodeLocation({
    apiService: { getStacktraceLink },
    organizationSlug: "acme",
    projectSlug: "backend",
    event,
  });
}

describe("resolveCodeLocation", () => {
  it("resolves the last in-app frame from the root exception", async () => {
    const event = createDefaultEvent({
      groupID: "123",
      platform: "javascript",
      sdk: { name: "sentry.javascript.node" },
      release: { lastCommit: { id: "abc123" } },
      entries: [
        {
          type: "exception",
          data: {
            values: [
              {
                type: "OriginalError",
                stacktrace: {
                  frames: [
                    {
                      filename: "src/original.ts",
                      lineNo: 10,
                      inApp: true,
                    },
                  ],
                },
              },
              {
                type: "WrappedError",
                mechanism: null,
                stacktrace: null,
              },
              {
                type: "RootError",
                stacktrace: {
                  frames: [
                    {
                      filename: "node_modules/library.js",
                      lineNo: 20,
                      inApp: false,
                    },
                    {
                      filename: "src/root.ts",
                      absPath: "/workspace/src/root.ts",
                      module: "src.root",
                      package: "backend",
                      lineNo: 42,
                      inApp: true,
                    },
                    {
                      filename: "runtime.js",
                      lineNo: 50,
                      inApp: false,
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    }) as Event;
    const getStacktraceLink = mockStacktraceLink().mockResolvedValue({
      config: { repoName: "acme/backend" },
      sourcePath: "services/api/src/root.ts",
      sourceUrl:
        "https://github.com/acme/backend/blob/main/services/api/src/root.ts#L42",
    });

    await expect(resolve(event, getStacktraceLink)).resolves.toEqual({
      repository: "acme/backend",
      path: "services/api/src/root.ts",
      line: 42,
      url: "https://github.com/acme/backend/blob/main/services/api/src/root.ts#L42",
    });
    expect(getStacktraceLink).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationSlug: "acme",
        projectSlug: "backend",
        file: "src/root.ts",
        absPath: "/workspace/src/root.ts",
        module: "src.root",
        package: "backend",
        lineNo: 42,
        platform: "javascript",
        groupId: "123",
        commitId: "abc123",
        sdkName: "sentry.javascript.node",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses the crashed thread when the event has no exception stacktrace", async () => {
    const event = createDefaultEvent({
      entries: [
        {
          type: "threads",
          data: {
            values: [
              {
                id: "worker",
                crashed: false,
                stacktrace: {
                  frames: [
                    {
                      filename: "src/worker.ts",
                      lineNo: 10,
                      inApp: true,
                    },
                  ],
                },
              },
              {
                id: "main",
                crashed: true,
                stacktrace: {
                  frames: [
                    {
                      filename: "src/main.ts",
                      lineNo: 84,
                      inApp: true,
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    }) as Event;
    const getStacktraceLink = mockStacktraceLink().mockResolvedValue({
      config: { repoName: "acme/backend" },
      sourcePath: "src/main.ts",
      sourceUrl: "https://github.com/acme/backend/blob/main/src/main.ts#L84",
    });

    await expect(resolve(event, getStacktraceLink)).resolves.toMatchObject({
      path: "src/main.ts",
      line: 84,
    });
    expect(getStacktraceLink).toHaveBeenCalledWith(
      expect.objectContaining({ file: "src/main.ts", lineNo: 84 }),
    );
  });

  it.each([
    "https://github.com/acme/backend/blob/abc123/src/main.ts#L84",
    "https://www.github.com/acme/backend/blob/abc123/src/main.ts#L84",
  ])(
    "uses a trusted embedded GitHub source link without another API call: %s",
    async (sourceUrl) => {
      const event = createDefaultEvent({
        entries: [
          {
            type: "exception",
            data: {
              values: [
                {
                  type: "Error",
                  stacktrace: {
                    frames: [
                      {
                        filename: "src/main.ts",
                        lineNo: 84,
                        inApp: true,
                        sourceLink: sourceUrl,
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }) as Event;
      const getStacktraceLink = mockStacktraceLink();

      await expect(resolve(event, getStacktraceLink)).resolves.toEqual({
        repository: "acme/backend",
        path: "src/main.ts",
        line: 84,
        url: sourceUrl,
      });
      expect(getStacktraceLink).not.toHaveBeenCalled();
    },
  );

  it("omits the location when source verification is unavailable", async () => {
    const event = createDefaultEvent() as Event;
    const getStacktraceLink = mockStacktraceLink().mockRejectedValue(
      new ApiPermissionError("Forbidden"),
    );

    await expect(resolve(event, getStacktraceLink)).resolves.toBeUndefined();
  });

  it("logs a warning instead of an issue when the API returns a 5xx", async () => {
    const { logIssue, logWarn } = logging;
    logIssue.mockClear();
    logWarn.mockClear();
    try {
      const event = createDefaultEvent({
        entries: [
          {
            type: "exception",
            data: {
              values: [
                {
                  type: "Error",
                  stacktrace: {
                    frames: [
                      { filename: "src/main.ts", lineNo: 10, inApp: true },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }) as Event;
      const getStacktraceLink = mockStacktraceLink().mockRejectedValue(
        new ApiServerError("Internal Error", 500),
      );

      await expect(resolve(event, getStacktraceLink)).resolves.toBeUndefined();
      expect(getStacktraceLink).toHaveBeenCalledOnce();
      expect(logIssue).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        "Stacktrace link lookup failed; omitting code location",
        expect.objectContaining({
          extra: expect.objectContaining({
            organizationSlug: "acme",
            projectSlug: "backend",
            status: 500,
          }),
        }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reports unexpected errors as issues", async () => {
    const { logIssue, logWarn } = logging;
    logIssue.mockClear();
    logWarn.mockClear();
    try {
      const event = createDefaultEvent({
        entries: [
          {
            type: "exception",
            data: {
              values: [
                {
                  type: "Error",
                  stacktrace: {
                    frames: [
                      { filename: "src/main.ts", lineNo: 10, inApp: true },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }) as Event;
      const getStacktraceLink = mockStacktraceLink().mockRejectedValue(
        new Error("boom"),
      );

      await expect(resolve(event, getStacktraceLink)).resolves.toBeUndefined();
      expect(getStacktraceLink).toHaveBeenCalledOnce();
      expect(logIssue).toHaveBeenCalledOnce();
      expect(logWarn).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("omits a mapped path when SCM source verification fails", async () => {
    const event = createDefaultEvent() as Event;
    const getStacktraceLink = mockStacktraceLink().mockResolvedValue({
      config: { repoName: "acme/backend" },
      sourcePath: "src/main.ts",
      sourceUrl: null,
    });

    await expect(resolve(event, getStacktraceLink)).resolves.toBeUndefined();
  });

  it("omits the location when source resolution times out", async () => {
    vi.useFakeTimers();
    try {
      const event = createDefaultEvent() as Event;
      const getStacktraceLink = mockStacktraceLink().mockImplementation(
        ({ signal }) => {
          if (!signal) {
            throw new Error("Expected source resolution to provide a signal");
          }
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        },
      );

      const result = resolve(event, getStacktraceLink);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(result).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
