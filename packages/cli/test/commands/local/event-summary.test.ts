import { describe, expect, test } from "vitest";
import { summarizeEnvelope } from "../../../src/commands/local/event-summary.js";

describe("summarizeEnvelope", () => {
  test("cuts a long title so list entries stay small", () => {
    const body = `SELECT ${"column, ".repeat(100)}id FROM orders`;
    const { title } = summarizeEnvelope({
      envelope: [{}, [[{ type: "log" }, { items: [{ level: "info", body }] }]]],
    });
    expect(title).toHaveLength(200);
    expect(title?.endsWith("…")).toBe(true);
    expect(body.startsWith(title?.slice(0, -1) ?? "")).toBe(true);
  });

  test("keeps a title at the limit as is", () => {
    const message = "x".repeat(200);
    expect(
      summarizeEnvelope({
        envelope: [{}, [[{ type: "event" }, { message }]]],
      }).title,
    ).toBe(message);
  });
});
