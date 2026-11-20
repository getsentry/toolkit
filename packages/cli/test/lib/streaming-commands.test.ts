/**
 * Tests for which raw `sdk.run()` arguments stream.
 */

import { describe, expect, test } from "vitest";
import { isStreamingInvocation } from "../../src/lib/streaming-commands.js";

describe("isStreamingInvocation", () => {
  test("a streaming command streams with any arguments", () => {
    expect(isStreamingInvocation(["log", "tail"])).toBe(true);
    expect(isStreamingInvocation(["log", "tail", "acme/api", "-i", "5"])).toBe(
      true,
    );
  });

  test("a streaming flag streams in long or --flag=value form", () => {
    expect(isStreamingInvocation(["dashboard", "view", "1", "--refresh"])).toBe(
      true,
    );
    expect(
      isStreamingInvocation(["dashboard", "view", "1", "--refresh=30"]),
    ).toBe(true);
  });

  test("-f is --fresh, not a stream", () => {
    expect(isStreamingInvocation(["log", "list", "-f"])).toBe(false);
    expect(isStreamingInvocation(["issue", "list", "-f"])).toBe(false);
  });

  test("the command path must lead the arguments", () => {
    expect(isStreamingInvocation(["log", "list", "tail"])).toBe(false);
    expect(isStreamingInvocation(["log"])).toBe(false);
  });
});
