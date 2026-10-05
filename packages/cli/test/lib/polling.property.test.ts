/**
 * Property-Based Tests for Polling Utility
 *
 * Uses fast-check to verify invariants of the poll() function
 * that are difficult to exhaustively test with example-based tests.
 */

import {
  array,
  asyncProperty,
  assert as fcAssert,
  integer,
  nat,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { TimeoutError } from "../../src/lib/errors.js";
import { poll } from "../../src/lib/polling.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

describe("poll properties", () => {
  test("returns immediately when shouldStop is true on first fetch", async () => {
    await fcAssert(
      asyncProperty(nat(100), async (stateValue) => {
        let fetchCount = 0;

        const result = await poll({
          fetchState: async () => {
            fetchCount += 1;
            return { value: stateValue };
          },
          shouldStop: () => true, // Always stop
          getProgressMessage: () => "Testing...",
          json: true, // Suppress output for cleaner tests
          pollIntervalMs: 10,
          timeoutMs: 1000,
        });

        expect(result.value).toBe(stateValue);
        expect(fetchCount).toBe(1); // Only called once
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns state that satisfies shouldStop predicate", async () => {
    await fcAssert(
      asyncProperty(
        integer({ min: 1, max: 5 }), // stopAfter: 1-5 fetches
        nat(100), // stateValue
        async (stopAfter, stateValue) => {
          let fetchCount = 0;

          const result = await poll({
            fetchState: async () => {
              fetchCount += 1;
              return { value: stateValue, count: fetchCount };
            },
            shouldStop: (state) => state.count >= stopAfter,
            getProgressMessage: () => "Testing...",
            json: true,
            pollIntervalMs: 5, // Fast polling for tests
            timeoutMs: 5000,
          });

          // Result should satisfy the stop condition
          expect(result.count).toBeGreaterThanOrEqual(stopAfter);
          expect(result.value).toBe(stateValue);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("throws TimeoutError when shouldStop never returns true", async () => {
    await fcAssert(
      asyncProperty(nat(50), async (stateValue) => {
        const timeoutMs = 50; // Very short timeout for testing
        const customMessage = `Custom timeout: ${stateValue}`;

        try {
          await poll({
            fetchState: async () => ({ value: stateValue }),
            shouldStop: () => false, // Never stop
            getProgressMessage: () => "Testing...",
            json: true,
            pollIntervalMs: 10,
            timeoutMs,
            timeoutMessage: customMessage,
          });
          // Should not reach here
          expect.unreachable("Expected TimeoutError to be thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(TimeoutError);
          expect((error as TimeoutError).message).toBe(customMessage);
        }
      }),
      { numRuns: Math.min(DEFAULT_NUM_RUNS, 20) } // Fewer runs since timeout tests are slow
    );
  });

  test("TimeoutError includes hint when provided", async () => {
    const customHint = "Try running the command again.";

    try {
      await poll({
        fetchState: async () => ({ value: 1 }),
        shouldStop: () => false,
        getProgressMessage: () => "Testing...",
        json: true,
        pollIntervalMs: 10,
        timeoutMs: 50,
        timeoutHint: customHint,
      });
      expect.unreachable("Expected TimeoutError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TimeoutError);
      const te = error as TimeoutError;
      expect(te.hint).toBe(customHint);
      expect(te.format()).toContain(customHint);
    }
  });

  test("fetchState call count is bounded by timeout/interval", async () => {
    await fcAssert(
      asyncProperty(
        integer({ min: 10, max: 50 }), // pollIntervalMs
        integer({ min: 50, max: 200 }), // timeoutMs
        async (pollIntervalMs, timeoutMs) => {
          let fetchCount = 0;

          // Ensure timeout > interval
          const actualTimeout = Math.max(timeoutMs, pollIntervalMs * 2);

          try {
            await poll({
              fetchState: async () => {
                fetchCount += 1;
                return { count: fetchCount };
              },
              shouldStop: () => false, // Never stop
              getProgressMessage: () => "Testing...",
              json: true,
              pollIntervalMs,
              timeoutMs: actualTimeout,
            });
          } catch {
            // Expected timeout
          }

          // Fetch count should be bounded by timeout/interval + some tolerance
          const maxExpectedCalls =
            Math.ceil(actualTimeout / pollIntervalMs) + 2;
          expect(fetchCount).toBeLessThanOrEqual(maxExpectedCalls);
          expect(fetchCount).toBeGreaterThanOrEqual(1); // At least one call
        }
      ),
      { numRuns: Math.min(DEFAULT_NUM_RUNS, 20) }
    );
  });

  test("null fetchState results are skipped until valid state", async () => {
    await fcAssert(
      asyncProperty(
        integer({ min: 1, max: 5 }), // nullCount: number of nulls before valid state
        nat(100), // stateValue
        async (nullCount, stateValue) => {
          let fetchCount = 0;

          const result = await poll({
            fetchState: async () => {
              fetchCount += 1;
              // Return null for first N calls, then valid state
              if (fetchCount <= nullCount) {
                return null;
              }
              return { value: stateValue };
            },
            shouldStop: () => true,
            getProgressMessage: () => "Testing...",
            json: true,
            pollIntervalMs: 5,
            timeoutMs: 5000,
          });

          expect(result.value).toBe(stateValue);
          expect(fetchCount).toBe(nullCount + 1);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("progress message is updated from state", async () => {
    await fcAssert(
      asyncProperty(
        array(nat(100), { minLength: 1, maxLength: 5 }),
        async (stateValues) => {
          let fetchIndex = 0;
          const messages: string[] = [];

          await poll({
            fetchState: async () => {
              const value = stateValues[fetchIndex];
              fetchIndex = Math.min(fetchIndex + 1, stateValues.length - 1);
              return { value };
            },
            shouldStop: (state) =>
              state.value === stateValues.at(-1) &&
              fetchIndex >= stateValues.length - 1,
            getProgressMessage: (state) => {
              const msg = `State: ${state.value}`;
              messages.push(msg);
              return msg;
            },
            json: true, // Suppress animation
            pollIntervalMs: 5,
            timeoutMs: 5000,
          });

          // Messages should have been generated for each non-null state
          expect(messages.length).toBeGreaterThanOrEqual(1);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("poll edge cases", () => {
  test("handles immediate timeout (timeoutMs = 0)", async () => {
    // With 0 timeout, should throw TimeoutError immediately or after first fetch
    await expect(
      poll({
        fetchState: async () => ({ value: 1 }),
        shouldStop: () => false,
        getProgressMessage: () => "Testing...",
        json: true,
        pollIntervalMs: 10,
        timeoutMs: 0,
      })
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  test("handles fetchState throwing errors", async () => {
    await expect(
      poll({
        fetchState: async () => {
          throw new Error("Fetch failed");
        },
        shouldStop: () => true,
        getProgressMessage: () => "Testing...",
        json: true,
        pollIntervalMs: 10,
        timeoutMs: 1000,
      })
    ).rejects.toThrow("Fetch failed");
  });
});
