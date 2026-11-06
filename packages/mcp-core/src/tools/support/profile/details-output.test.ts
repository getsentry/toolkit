import { transactionProfileV1Fixture } from "@sentry/mcp-server-mocks";
import { describe, expect, it } from "vitest";
import { TransactionProfileSchema } from "../../../api-client/schema";
import type {
  ProfileChunk,
  TransactionProfile,
} from "../../../api-client/types";
import {
  buildContinuousProfileDetails,
  buildTransactionProfileDetails,
} from "./details-output";

const profileUrl =
  "https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/cfe78a5c892d4a64a962d837673398d2/flamegraph/";

function createMockProfileChunk(): ProfileChunk {
  return {
    chunk_id: "chunk-abc123",
    profiler_id: "profiler-xyz789",
    platform: "python",
    release: "1.0.0",
    version: "1",
    environment: "production",
    profile: {
      frames: [
        {
          filename: "main.py",
          function: "handle_request",
          in_app: true,
          lineno: 10,
        },
        {
          filename: "utils.py",
          function: "fetch_data",
          in_app: true,
          lineno: 25,
        },
        {
          filename: "psycopg2/pool.py",
          function: "execute",
          in_app: false,
          lineno: 100,
        },
      ],
      samples: [
        { stack_id: 0, thread_id: "1", timestamp: 1000 },
        { stack_id: 0, thread_id: "1", timestamp: 2000 },
        { stack_id: 1, thread_id: "2", timestamp: 3000 },
      ],
      stacks: [
        [0, 1, 2],
        [0, 1],
      ],
      thread_metadata: {
        "1": { name: "main" },
        "2": { name: "worker" },
      },
    },
  } as ProfileChunk;
}

function createMockTransactionProfile(): TransactionProfile {
  // Parse through the schema so transforms run (e.g. numeric thread IDs).
  return TransactionProfileSchema.parse(
    structuredClone(transactionProfileV1Fixture),
  );
}

function continuousSamples(
  chunk: ProfileChunk,
  options = { focusOnUserCode: false },
) {
  const { profile, samples } = buildContinuousProfileDetails(
    chunk,
    {
      profileUrl,
      project: "backend",
      profilerId: "profiler-xyz789",
      start: "2024-01-01T00:00:00Z",
      end: "2024-01-01T01:00:00Z",
    },
    options,
  );
  if (profile.profileType !== "continuous" || !samples) {
    throw new Error("expected a continuous profile");
  }
  return samples;
}

function transactionDetails(
  profile: TransactionProfile,
  options = { focusOnUserCode: true },
) {
  const { profile: details, samples } = buildTransactionProfileDetails(
    profile,
    { profileUrl, project: "backend", profileId: "fallback", traceUrl: null },
    options,
  );
  if (details.profileType !== "transaction" || !samples) {
    throw new Error("expected a transaction profile");
  }
  return { ...details, samples };
}

describe("buildContinuousProfileDetails", () => {
  it("summarizes samples, threads, and frames", () => {
    expect(continuousSamples(createMockProfileChunk())).toEqual({
      frameCount: 3,
      sampleCount: 3,
      stackCount: 2,
      threads: [
        { id: "1", name: "main", sampleCount: 2 },
        { id: "2", name: "worker", sampleCount: 1 },
      ],
      topFrames: [
        {
          function: "handle_request",
          location: "main.py:10",
          isApplication: true,
          count: 3,
        },
        {
          function: "fetch_data",
          location: "utils.py:25",
          isApplication: true,
          count: 3,
        },
        {
          function: "execute",
          location: "psycopg2/pool.py:100",
          isApplication: false,
          count: 2,
        },
      ],
    });
  });

  it("filters to user code when requested", () => {
    const samples = continuousSamples(createMockProfileChunk(), {
      focusOnUserCode: true,
    });
    expect(samples.topFrames.map((frame) => frame.function)).toEqual([
      "handle_request",
      "fetch_data",
    ]);
  });

  it("shows class_name.function and falls back to module for location", () => {
    const chunk = createMockProfileChunk();
    chunk.profile.frames.push(
      {
        filename: "UserService.java",
        function: "getUsers",
        in_app: true,
        lineno: 87,
        class_name: "UserService",
      },
      {
        filename: null,
        function: "native_call",
        in_app: false,
        lineno: null,
        module: "libc.so",
      },
    );
    chunk.profile.stacks.push([3, 4]);
    chunk.profile.samples.push({
      stack_id: 2,
      thread_id: "1",
      timestamp: 4000,
    });

    const frames = continuousSamples(chunk).topFrames;
    expect(frames).toContainEqual(
      expect.objectContaining({
        function: "UserService.getUsers",
        location: "UserService.java:87",
      }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({ function: "native_call", location: "libc.so" }),
    );
  });
});

describe("buildTransactionProfileDetails", () => {
  it("counts frame occurrences from samples instead of unique stack definitions", () => {
    expect(
      transactionDetails(createMockTransactionProfile()).samples.topFrames,
    ).toEqual([
      {
        function: "handle_request",
        location: "main.py:42",
        isApplication: true,
        count: 3,
      },
      {
        function: "execute_query",
        location: "db.py:118",
        isApplication: true,
        count: 2,
      },
    ]);
  });

  it("filters to user code before limiting top frames", () => {
    const profile = createMockTransactionProfile();
    profile.profile.frames = [
      ...Array.from({ length: 11 }, (_, index) => ({
        filename: `vendor_${index}.py`,
        function: `library_${index}`,
        in_app: false,
        lineno: index + 1,
      })),
      { filename: "app.py", function: "app_handler", in_app: true, lineno: 99 },
    ];
    profile.profile.stacks = profile.profile.frames.map((_, index) => [index]);
    profile.profile.samples = [
      ...Array.from({ length: 22 }, (_, index) => ({
        stack_id: Math.floor(index / 2),
        thread_id: "1",
        elapsed_since_start_ns: index * 10_000_000,
      })),
      { stack_id: 11, thread_id: "1", elapsed_since_start_ns: 220_000_000 },
    ];

    expect(transactionDetails(profile).samples.topFrames).toEqual([
      {
        function: "app_handler",
        location: "app.py:99",
        isApplication: true,
        count: 1,
      },
    ]);
  });

  it("falls back to elapsed_since_start_ns when relative bounds are missing", () => {
    // Regression test for getsentry/sentry-mcp issue MCP-SERVER-FRN: vroom
    // emits V1 samples with elapsed_since_start_ns (uint64 nanoseconds)
    // instead of timestamp, and numeric thread_id.
    const profile = createMockTransactionProfile();
    profile.transaction!.relative_start_ns = undefined;
    profile.transaction!.relative_end_ns = undefined;
    profile.profile.samples = [
      { stack_id: 0, thread_id: "1", elapsed_since_start_ns: 0 },
      { stack_id: 1, thread_id: "1", elapsed_since_start_ns: 50_000_000 },
      { stack_id: 1, thread_id: "1", elapsed_since_start_ns: 100_000_000 },
    ];

    expect(transactionDetails(profile).durationMs).toBe(100);
  });

  it("preserves sub-millisecond V1 sample durations", () => {
    const profile = createMockTransactionProfile();
    profile.transaction!.relative_start_ns = undefined;
    profile.transaction!.relative_end_ns = undefined;
    profile.profile.samples = [
      { stack_id: 0, thread_id: "1", elapsed_since_start_ns: 0 },
      { stack_id: 1, thread_id: "1", elapsed_since_start_ns: 250_000 },
      { stack_id: 1, thread_id: "1", elapsed_since_start_ns: 500_000 },
    ];

    expect(transactionDetails(profile).durationMs).toBe(0.5);
  });
});
