import { describe, expect, test } from "vitest";
import { arrangeShortcutHints } from "../../../../src/lib/init/ui/ink-shortcuts.js";

describe("arrangeShortcutHints", () => {
  test("orders by priority while preserving same-priority order", () => {
    expect(
      arrangeShortcutHints([
        { key: "enter", action: "confirm", priority: 40 },
        { key: "\u2190\u2192", action: "switch tab", priority: 10 },
        { key: "esc", action: "cancel", priority: 40 },
      ])
    ).toEqual([
      { key: "\u2190\u2192", action: "switch tab", priority: 10 },
      { key: "enter", action: "confirm", priority: 40 },
      { key: "esc", action: "cancel", priority: 40 },
    ]);
  });

  test("drops duplicate key/action pairs", () => {
    expect(
      arrangeShortcutHints([
        { key: "s", action: "toggle status", priority: 20 },
        { key: "s", action: "toggle status", priority: 20 },
        { key: "s", action: "save", priority: 30 },
      ])
    ).toEqual([
      { key: "s", action: "toggle status", priority: 20 },
      { key: "s", action: "save", priority: 30 },
    ]);
  });
});
