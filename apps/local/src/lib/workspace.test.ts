import { describe, expect, test } from "vitest";
import {
  isAiEvent,
  workspaceForItem,
  workspaceFromPath,
  workspacePath,
} from "./workspace.ts";

describe("workspace routes", () => {
  test("maps retained events to their canonical workspaces", () => {
    expect(workspaceForItem({ id: "raw", type: "envelope", text: "[]" })).toBe(
      "envelopes",
    );
    expect(
      workspaceForItem({
        id: "error",
        type: "event",
        text: "{}",
        metadata: { title: "Broken", level: "error" },
      }),
    ).toBe("errors");
    expect(
      workspaceForItem({
        id: "ai",
        type: "span",
        text: "{}",
        metadata: { title: "Prompt", operation: "gen_ai.invoke_agent" },
      }),
    ).toBe("ai");
  });

  test("uses Live Activity for the compatible root and unknown paths", () => {
    expect(workspaceFromPath("/")).toBe("live");
    expect(workspaceFromPath("/not-a-workspace")).toBe("live");
    expect(workspacePath("traces")).toBe("/traces");
  });
});

describe("AI classification", () => {
  test.each(["queue.wait", "auto.http.aiohttp", "email.send"])(
    "keeps ordinary %s telemetry in traces",
    (value) => {
      const item = {
        id: "span",
        type: "span",
        text: "{}",
        metadata: { title: "work", operation: value, origin: value },
      };
      expect(isAiEvent(item)).toBe(false);
      expect(workspaceForItem(item)).toBe("traces");
    },
  );
  test.each([
    "ai.chat",
    "gen_ai.invoke_agent",
    "llm.generate",
    "auto.ai.openai",
  ])("recognizes the AI namespace in %s", (value) =>
    expect(
      isAiEvent({
        id: "span",
        type: "span",
        text: "{}",
        metadata: { title: "Prompt", operation: value },
      }),
    ).toBe(true),
  );
});
