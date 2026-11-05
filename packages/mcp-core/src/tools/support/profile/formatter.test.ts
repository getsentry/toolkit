import { transactionProfileV1Fixture } from "@sentry/mcp-server-mocks";
import { describe, expect, it } from "vitest";
import { TransactionProfileSchema } from "../../../api-client/schema";
import type {
  ProfileChunk,
  TransactionProfile,
} from "../../../api-client/types";
import {
  formatProfileChunkAnalysis,
  formatTransactionProfileAnalysis,
} from "./formatter";

/**
 * Mock profile chunk fixture for testing.
 */
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
  // Parse the fixture through the schema so transforms run (e.g. normalizing
  // numeric thread_id and active_thread_id to strings). This keeps test
  // fixtures in sync with what production code actually receives after the
  // API client validates the response.
  return TransactionProfileSchema.parse(
    structuredClone(transactionProfileV1Fixture),
  );
}

describe("formatter", () => {
  describe("formatProfileChunkAnalysis", () => {
    it("includes chunk metadata", () => {
      const chunk = createMockProfileChunk();
      const output = formatProfileChunkAnalysis(chunk, {
        focusOnUserCode: false,
      });

      expect(output).toContain("# Profile Chunk Details");
      expect(output).toContain("**Chunk ID**: chunk-abc123");
      expect(output).toContain("**Profiler ID**: profiler-xyz789");
      expect(output).toContain("**Platform**: python");
      expect(output).toContain("**Release**: 1.0.0");
      expect(output).toContain("**Environment**: production");
    });

    it("includes sample summary", () => {
      const chunk = createMockProfileChunk();
      const output = formatProfileChunkAnalysis(chunk, {
        focusOnUserCode: false,
      });

      expect(output).toContain("## Sample Summary");
      expect(output).toContain("**Total Frames**: 3");
      expect(output).toContain("**Total Samples**: 3");
      expect(output).toContain("**Total Stacks**: 2");
      expect(output).toContain("**Threads**: 2");
    });

    it("includes thread information", () => {
      const chunk = createMockProfileChunk();
      const output = formatProfileChunkAnalysis(chunk, {
        focusOnUserCode: false,
      });

      expect(output).toContain("## Thread Information");
      expect(output).toContain("**Thread 1**: main");
      expect(output).toContain("**Thread 2**: worker");
    });

    it("includes top frames by occurrence", () => {
      const chunk = createMockProfileChunk();
      const output = formatProfileChunkAnalysis(chunk, {
        focusOnUserCode: false,
      });

      expect(output).toContain("## Top Frames by Occurrence");
      expect(output).toContain("| Function | File:Line | Count | Type |");
      expect(output).toContain("`handle_request`");
    });

    it("filters to user code when requested", () => {
      const chunk = createMockProfileChunk();
      const output = formatProfileChunkAnalysis(chunk, {
        focusOnUserCode: true,
      });

      // Library frame should not appear in table
      expect(output).not.toContain("`execute`");
    });

    it("shows class_name.function for Java/Android frames", () => {
      const chunk = createMockProfileChunk();
      chunk.profile.frames.push({
        filename: "UserService.java",
        function: "getUsers",
        in_app: true,
        lineno: 87,
        class_name: "UserService",
      });
      // Add a stack referencing the new frame
      chunk.profile.stacks.push([3]);
      chunk.profile.samples.push({
        stack_id: 2,
        thread_id: "1",
        timestamp: 4000,
      });

      const output = formatProfileChunkAnalysis(chunk, {
        focusOnUserCode: false,
      });

      expect(output).toContain("`UserService.getUsers`");
    });

    it("falls back to module when filename is absent", () => {
      const chunk = createMockProfileChunk();
      chunk.profile.frames.push({
        filename: null,
        function: "native_call",
        in_app: false,
        lineno: null,
        module: "libc.so",
      });
      chunk.profile.stacks.push([3]);
      chunk.profile.samples.push({
        stack_id: 2,
        thread_id: "1",
        timestamp: 4000,
      });

      const output = formatProfileChunkAnalysis(chunk, {
        focusOnUserCode: false,
      });

      expect(output).toContain("libc.so");
    });
  });

  describe("formatTransactionProfileAnalysis", () => {
    it("counts frame occurrences from samples instead of unique stack definitions", () => {
      const profile = createMockTransactionProfile();

      const output = formatTransactionProfileAnalysis(profile, {
        focusOnUserCode: true,
        profileUrl:
          "https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/cfe78a5c892d4a64a962d837673398d2/flamegraph/",
        projectSlug: "backend",
        traceUrl:
          "https://sentry-mcp-evals.sentry.io/explore/traces/trace/a4d1aae7216b47ff8117cf4e09ce9d0a",
      });

      expect(output).toContain(
        "| `handle_request` | main.py:42 | 3 | User Code |",
      );
      expect(output).toContain(
        "| `execute_query` | db.py:118 | 2 | User Code |",
      );
    });

    it("filters to user code before limiting hotspot rows", () => {
      const profile = createMockTransactionProfile();

      profile.profile.frames = [
        ...Array.from({ length: 11 }, (_, index) => ({
          filename: `vendor_${index}.py`,
          function: `library_${index}`,
          in_app: false,
          lineno: index + 1,
          module: `vendor.module_${index}`,
          abs_path: `/usr/lib/vendor_${index}.py`,
          platform: "python",
          lang: "python",
        })),
        {
          filename: "app.py",
          function: "app_handler",
          in_app: true,
          lineno: 99,
          module: "app.handlers",
          abs_path: "/app/src/app.py",
          platform: "python",
          lang: "python",
        },
      ];
      profile.profile.stacks = profile.profile.frames.map((_, index) => [
        index,
      ]);
      profile.profile.samples = [
        ...Array.from({ length: 22 }, (_, index) => ({
          stack_id: Math.floor(index / 2),
          thread_id: "1",
          elapsed_since_start_ns: index * 10_000_000,
        })),
        {
          stack_id: 11,
          thread_id: "1",
          elapsed_since_start_ns: 220_000_000,
        },
      ];

      const output = formatTransactionProfileAnalysis(profile, {
        focusOnUserCode: true,
        profileUrl:
          "https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/cfe78a5c892d4a64a962d837673398d2/flamegraph/",
        projectSlug: "backend",
      });

      expect(output).toContain("## Top Frames by Occurrence");
      expect(output).toContain("| `app_handler` | app.py:99 | 1 | User Code |");
      expect(output).not.toContain("`library_0`");
    });

    it("falls back to elapsed_since_start_ns for V1 transaction profiles when relative bounds are missing", () => {
      // Regression test for getsentry/sentry-mcp issue MCP-SERVER-FRN: vroom
      // emits V1 samples with elapsed_since_start_ns (uint64 nanoseconds)
      // instead of timestamp, and numeric thread_id.
      const profile = createMockTransactionProfile();

      if (profile.transaction) {
        profile.transaction.relative_start_ns = undefined;
        profile.transaction.relative_end_ns = undefined;
      }

      profile.profile.samples = [
        { stack_id: 0, thread_id: "1", elapsed_since_start_ns: 0 },
        { stack_id: 1, thread_id: "1", elapsed_since_start_ns: 50_000_000 },
        { stack_id: 1, thread_id: "1", elapsed_since_start_ns: 100_000_000 },
      ];

      const output = formatTransactionProfileAnalysis(profile, {
        focusOnUserCode: true,
        profileUrl:
          "https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/cfe78a5c892d4a64a962d837673398d2/flamegraph/",
        projectSlug: "backend",
      });

      expect(output).toContain("- **Duration**: 100ms");
    });

    it("preserves sub-millisecond V1 sample durations", () => {
      const profile = createMockTransactionProfile();

      if (profile.transaction) {
        profile.transaction.relative_start_ns = undefined;
        profile.transaction.relative_end_ns = undefined;
      }

      profile.profile.samples = [
        { stack_id: 0, thread_id: "1", elapsed_since_start_ns: 0 },
        { stack_id: 1, thread_id: "1", elapsed_since_start_ns: 250_000 },
        { stack_id: 1, thread_id: "1", elapsed_since_start_ns: 500_000 },
      ];

      const output = formatTransactionProfileAnalysis(profile, {
        focusOnUserCode: true,
        profileUrl:
          "https://sentry-mcp-evals.sentry.io/explore/profiling/profile/backend/cfe78a5c892d4a64a962d837673398d2/flamegraph/",
        projectSlug: "backend",
      });

      expect(output).toContain("- **Duration**: 500µs");
    });
  });
});
