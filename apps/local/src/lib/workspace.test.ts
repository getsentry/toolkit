import { describe, expect, test } from "vitest";
import { decodeEnvelope } from "./spotlight.ts";
import {
  eventListLabel,
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

describe("event list labels", () => {
  const transaction = (operation: string, title: string) =>
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: title,
              transaction_info: { source: "custom" },
              request: {
                url: "http://localhost:5050/transaction",
                method: "GET",
              },
              contexts: {
                trace: { trace_id: "t", span_id: "s", op: operation },
              },
            },
          ],
        ],
      ]),
      operation,
    )[0]!;

  test("custom transactions keep their name inside a request", () => {
    // sentry-python: start_transaction(name="custom-batch-job", op="task") in a Flask view.
    expect(eventListLabel(transaction("task", "custom-batch-job"))).toEqual({
      badge: "task",
      title: "custom-batch-job",
    });
  });

  test("browser pageloads and navigations show their op and page name", () => {
    expect(eventListLabel(transaction("pageload", "/orders/:id"))).toEqual({
      badge: "pageload",
      title: "/orders/:id",
    });
    expect(eventListLabel(transaction("navigation", "/settings"))).toEqual({
      badge: "navigation",
      title: "/settings",
    });
  });

  test("request transactions show their method and route", () => {
    expect(eventListLabel(transaction("http.server", "tx"))).toEqual({
      badge: "GET",
      title: "/transaction",
    });
  });
});
