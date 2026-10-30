import { describe, expect, test } from "vitest";
import { parseEvalJsonAnswer } from "./json-answer";

describe("parseEvalJsonAnswer", () => {
  test("uses the fenced answer when later prose contains API paths and JSON examples", () => {
    const text = [
      "Done. Verified by re-reading the alert after the write:",
      "",
      "```json",
      '{"id": "701", "enabled": false, "frequency": 60}',
      "```",
      "",
      'Preserved unchanged: monitor connection (`detectorIds: ["901"]`).',
      "",
      'Note: alerts are exposed as `workflows` in the API (`PUT /organizations/{org}/workflows/701/`), and frequency lives in `config.frequency` in minutes. The spec\'s config example shows `{"frequency":3600}`. No other alerts were touched.',
    ].join("\n");

    expect(parseEvalJsonAnswer(text)).toEqual({
      id: "701",
      enabled: false,
      frequency: 60,
    });
  });

  test.each([
    '{"id":"701"}',
    'Saved values: {"id":"701"}. Verified.',
    '```\n{"id":"701"}\n```',
    '```json\n{"id":"701"}\n```',
  ])("accepts the existing answer format: %s", (text) => {
    expect(parseEvalJsonAnswer(text)).toEqual({ id: "701" });
  });

  test.each([
    '```json\n{"id":}\n```\nCorrection: {"id":"701"}',
    '```json\n{"id":"701"}\n```\n```json\n{"id":"702"}\n```',
    '```json\n{"id":"701"}\n```\n```\n{"id":"701"}\n```',
    '```json\n{"id":"701"}',
    '{"id":}',
    'First: {"id":"701"}. Second: {"id":"702"}.',
    "No saved values are available.",
  ])("rejects malformed, ambiguous, or absent answers: %s", (text) => {
    expect(() => parseEvalJsonAnswer(text)).toThrow(SyntaxError);
  });
});
