import { describe, expect, test } from "vitest";
import {
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
