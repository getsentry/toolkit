import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithTimeout, retryWithBackoff } from "./fetch-utils";
import { ApiError } from "../api-client/index";

describe("fetch-utils", () => {
  describe("fetchWithTimeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("should complete successfully when response is faster than timeout", async () => {
      const mockResponse = new Response("Success", { status: 200 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const responsePromise = fetchWithTimeout("https://example.com", {}, 5000);
      const response = await responsePromise;

      expect(response).toBe(mockResponse);
      expect(fetch).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("should throw timeout error when request takes too long", async () => {
      let rejectFn: (error: Error) => void;
      const fetchPromise = new Promise((_, reject) => {
        rejectFn = reject;
      });

      global.fetch = vi.fn().mockImplementation(() => fetchPromise);

      const responsePromise = fetchWithTimeout("https://example.com", {}, 50);

      // Advance timer to trigger the abort
      vi.advanceTimersByTime(50);

      // Now reject with AbortError
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      rejectFn!(error);

      await expect(responsePromise).rejects.toThrow(
        "Request timeout after 50ms",
      );
    });

    it("should preserve non-abort errors", async () => {
      const networkError = new Error("Network error");
      global.fetch = vi.fn().mockRejectedValue(networkError);

      await expect(
        fetchWithTimeout("https://example.com", {}, 5000),
      ).rejects.toThrow("Network error");
    });

    it("should merge options with signal", async () => {
      const mockResponse = new Response("Success", { status: 200 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      await fetchWithTimeout(
        "https://example.com",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ test: true }),
        },
        5000,
      );

      expect(fetch).toHaveBeenCalledWith(
        "https://example.com",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ test: true }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("should use default timeout of 30 seconds", async () => {
      const mockResponse = new Response("Success", { status: 200 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      await fetchWithTimeout("https://example.com");

      expect(fetch).toHaveBeenCalled();
    });

    it("should accept URL object", async () => {
      const mockResponse = new Response("Success", { status: 200 });
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const url = new URL("https://example.com/path");
      await fetchWithTimeout(url, {}, 5000);

      expect(fetch).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });
  });

  describe("retryWithBackoff", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("succeeds on first attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const result = await retryWithBackoff(fn);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and succeeds", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Temporary failure"))
        .mockResolvedValueOnce("success");

      const promise = retryWithBackoff(fn, { initialDelay: 10 });

      // Wait for first failure and retry
      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("uses exponential backoff", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Failure 1"))
        .mockRejectedValueOnce(new Error("Failure 2"))
        .mockResolvedValueOnce("success");

      const promise = retryWithBackoff(fn, { initialDelay: 100 });

      // First retry after 100ms
      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(2);

      // Second retry after 200ms (exponential backoff)
      await vi.advanceTimersByTimeAsync(200);
      expect(fn).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toBe("success");
    });

    it("respects maxRetries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Persistent failure"));

      const promise = retryWithBackoff(fn, {
        maxRetries: 2,
        initialDelay: 10,
      });

      // Immediately add a catch handler to prevent unhandled rejection
      promise.catch(() => {
        // Expected rejection, handled
      });

      // Advance timers to trigger all retries
      await vi.runAllTimersAsync();

      // Now await the promise and expect it to reject
      await expect(promise).rejects.toThrow("Persistent failure");

      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("respects shouldRetry predicate", async () => {
      const apiError = new ApiError("Bad Request", 400);
      const fn = vi.fn().mockRejectedValue(apiError);

      await expect(
        retryWithBackoff(fn, {
          shouldRetry: (error) => {
            if (error instanceof ApiError) {
              return (error.status ?? 0) >= 500;
            }
            return true;
          },
        }),
      ).rejects.toThrow(apiError);

      expect(fn).toHaveBeenCalledTimes(1); // no retry for 400 error
    });

    it("caps delay at 30 seconds", async () => {
      const fn = vi.fn();

      // Mock function that fails many times
      for (let i = 0; i < 10; i++) {
        fn.mockRejectedValueOnce(new Error(`Failure ${i}`));
      }
      fn.mockResolvedValueOnce("success");

      const promise = retryWithBackoff(fn, {
        maxRetries: 10,
        initialDelay: 1000,
      });

      // Advance through multiple retries
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30000); // Max delay
      }

      const result = await promise;
      expect(result).toBe("success");
    });
  });
});
