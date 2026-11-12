import type { RateLimit } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "./rate-limiter";

describe("checkRateLimit", () => {
  let mockRateLimiter: RateLimit;

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  it("allows request when rate limiter binding is not available", async () => {
    const result = await checkRateLimit("192.168.1.1", undefined, {
      keyPrefix: "test",
      errorMessage: "Rate limited",
    });

    expect(result.allowed).toBe(true);
    expect(result.errorMessage).toBeUndefined();
  });

  it("allows request when rate limit not exceeded", async () => {
    mockRateLimiter = {
      limit: vi.fn().mockResolvedValue({ success: true }),
    };

    const result = await checkRateLimit("192.168.1.1", mockRateLimiter, {
      keyPrefix: "test",
      errorMessage: "Rate limited",
    });

    expect(result.allowed).toBe(true);
    expect(result.errorMessage).toBeUndefined();
    expect(mockRateLimiter.limit).toHaveBeenCalledWith({
      key: expect.stringMatching(/^test:/),
    });
  });

  it("denies request when rate limit exceeded", async () => {
    mockRateLimiter = {
      limit: vi.fn().mockResolvedValue({ success: false }),
    };

    const result = await checkRateLimit("192.168.1.1", mockRateLimiter, {
      keyPrefix: "test",
      errorMessage: "Rate limit exceeded. Please wait.",
    });

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toBe("Rate limit exceeded. Please wait.");
  });

  it("uses hashed identifier for privacy", async () => {
    mockRateLimiter = {
      limit: vi.fn().mockResolvedValue({ success: true }),
    };

    await checkRateLimit("192.168.1.1", mockRateLimiter, {
      keyPrefix: "test",
      errorMessage: "Rate limited",
    });

    // Verify the key is hashed and not the raw IP
    expect(mockRateLimiter.limit).toHaveBeenCalledWith({
      key: expect.not.stringContaining("192.168.1.1"),
    });

    // Verify the key has the correct format (prefix:hash)
    const callArg = (mockRateLimiter.limit as any).mock.calls[0][0];
    expect(callArg.key).toMatch(/^test:[0-9a-f]{16}$/);
  });

  it("uses consistent hash for same identifier", async () => {
    mockRateLimiter = {
      limit: vi.fn().mockResolvedValue({ success: true }),
    };

    await checkRateLimit("192.168.1.1", mockRateLimiter, {
      keyPrefix: "test",
      errorMessage: "Rate limited",
    });

    const firstKey = (mockRateLimiter.limit as any).mock.calls[0][0].key;

    // Clear and call again with same IP
    vi.clearAllMocks();

    await checkRateLimit("192.168.1.1", mockRateLimiter, {
      keyPrefix: "test",
      errorMessage: "Rate limited",
    });

    const secondKey = (mockRateLimiter.limit as any).mock.calls[0][0].key;

    // Same identifier should produce same hash
    expect(firstKey).toBe(secondKey);
  });

  it("uses different keys for different identifiers", async () => {
    mockRateLimiter = {
      limit: vi.fn().mockResolvedValue({ success: true }),
    };

    await checkRateLimit("192.168.1.1", mockRateLimiter, {
      keyPrefix: "test",
      errorMessage: "Rate limited",
    });

    const firstKey = (mockRateLimiter.limit as any).mock.calls[0][0].key;

    // Clear and call with different IP
    vi.clearAllMocks();

    await checkRateLimit("192.168.1.2", mockRateLimiter, {
      keyPrefix: "test",
      errorMessage: "Rate limited",
    });

    const secondKey = (mockRateLimiter.limit as any).mock.calls[0][0].key;

    // Different identifiers should produce different hashes
    expect(firstKey).not.toBe(secondKey);
  });

  it("includes key prefix in rate limit key", async () => {
    mockRateLimiter = {
      limit: vi.fn().mockResolvedValue({ success: true }),
    };

    await checkRateLimit("192.168.1.1", mockRateLimiter, {
      keyPrefix: "mcp:ip",
      errorMessage: "Rate limited",
    });

    expect(mockRateLimiter.limit).toHaveBeenCalledWith({
      key: expect.stringMatching(/^mcp:ip:/),
    });
  });

  it("allows request when rate limiter throws error", async () => {
    mockRateLimiter = {
      limit: vi.fn().mockRejectedValue(new Error("Rate limiter service error")),
    };

    const result = await checkRateLimit("192.168.1.1", mockRateLimiter, {
      keyPrefix: "test",
      errorMessage: "Rate limited",
    });

    // Should allow request to proceed even if rate limiter fails
    expect(result.allowed).toBe(true);
    expect(result.errorMessage).toBeUndefined();
  });
});
