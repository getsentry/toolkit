import { describe, expect, test } from "vitest";
import {
  getConnectionPresentation,
  getWorkspaceEmptyState,
} from "./presentation.ts";
import { workspaceViews } from "./workspace.ts";

describe("getConnectionPresentation", () => {
  test("describes an active local receiver as connected", () => {
    expect(getConnectionPresentation("connected")).toEqual({
      label: "Connected to local receiver",
      tone: "success",
    });
  });

  test("explains when no local stream has been provided", () => {
    expect(getConnectionPresentation("missing")).toEqual({
      label: "Waiting for a local stream",
      tone: "neutral",
    });
  });

  test("makes a failed receiver visible in the status control", () => {
    expect(getConnectionPresentation("failed")).toEqual({
      label: "Receiver unavailable",
      tone: "warning",
    });
  });

  test("describes a stopped capture without implying the receiver disconnected", () => {
    expect(getConnectionPresentation("closed")).toEqual({
      label: "Capture stopped",
      tone: "neutral",
    });
  });
});

describe("getWorkspaceEmptyState", () => {
  const logs = {
    view: "logs" as const,
    label: "Logs",
    singularLabel: "log",
    filtered: false,
  };

  test("filtered results take precedence over every lifecycle state", () => {
    for (const state of ["capturing", "saved", "offline", "cleared"] as const) {
      expect(
        getWorkspaceEmptyState({ ...logs, filtered: true, state }),
      ).toEqual(
        getWorkspaceEmptyState({ ...logs, filtered: true, state: "capturing" }),
      );
    }
  });

  test("filtered results name their scope and offer filter recovery", () => {
    const empty = getWorkspaceEmptyState({
      ...logs,
      filtered: true,
      state: "saved",
    });
    expect(empty.title).toBe("No matching logs");
    expect(empty.description).toMatch(/adjust.*filter|clear/i);
  });

  test("capturing views offer a relevant telemetry trigger", () => {
    const triggers = {
      live: /send.*event/i,
      traces: /instrumented.*request|operation/i,
      errors: /error.*failed request/i,
      logs: /structured log/i,
      ai: /instrumented AI/i,
      envelopes: /SDK.*envelope/i,
      sdks: /session.*client report/i,
      feedback: /submit.*feedback/i,
      profiles: /profiling/i,
    };
    for (const view of workspaceViews) {
      expect(
        getWorkspaceEmptyState({
          ...logs,
          view,
          singularLabel: view === "live" ? "event" : logs.singularLabel,
          state: "capturing",
        }).description,
      ).toMatch(triggers[view]);
    }
  });

  test("saved captures explain the absence without promising new events", () => {
    const empty = getWorkspaceEmptyState({ ...logs, state: "saved" });
    expect(empty.title).toBe("No logs saved");
    expect(empty.description).toMatch(/capture has stopped/i);
    expect(empty.description).not.toMatch(/will appear|waiting|send|trigger/i);
  });

  test("offline views offer reconnection and preserve the tab's history", () => {
    const empty = getWorkspaceEmptyState({ ...logs, state: "offline" });
    expect(empty.title).toBe("No logs displayed");
    expect(empty.description).toMatch(/reconnect/i);
    expect(empty.description).toMatch(/history.*remain|retain.*history/i);
  });

  test("a cleared tab distinguishes reloadable history from receiver deletion", () => {
    const empty = getWorkspaceEmptyState({ ...logs, state: "cleared" });
    expect(empty.title).toBe("No logs displayed");
    expect(empty.description).toMatch(/Clear view only affects this tab/);
    expect(empty.description).toMatch(/reload.*capture/i);
    expect(empty.description).toMatch(/receiver.*trim/i);
  });
});
