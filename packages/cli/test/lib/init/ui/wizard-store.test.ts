/**
 * Tests for the wizard store's step-progress state.
 *
 * Covers:
 *   - canonical pre-population from CHECKLIST_VISIBLE_STEPS
 *   - in_progress / completed transitions
 *   - implicit skip back-fill when a later step starts
 *   - idempotent re-entry (a step suspending multiple times)
 *   - protection against `skipped` clobbering completed entries
 *
 * The Ink app itself is not tested here — see the React tree
 * verification via direct `createInkUI()` invocation in
 * dev/binary builds. This test file focuses on the pure data layer.
 */

import { describe, expect, test } from "vitest";
import {
  CANONICAL_STEP_ORDER,
  CHECKLIST_VISIBLE_STEPS,
} from "../../../../src/lib/init/clack-utils.js";
import { WizardStore } from "../../../../src/lib/init/ui/wizard-store.js";

describe("WizardStore step progress", () => {
  test("pre-populates the checklist from CHECKLIST_VISIBLE_STEPS", () => {
    const store = new WizardStore();
    const snapshot = store.getSnapshot();
    expect(snapshot.steps.map((entry) => entry.id)).toEqual(
      CHECKLIST_VISIBLE_STEPS.slice()
    );
    expect(snapshot.steps.every((entry) => entry.status === "pending")).toBe(
      true
    );
    expect(snapshot.steps.some((entry) => entry.id === "install-deps")).toBe(
      false
    );
    expect(
      snapshot.steps.find((entry) => entry.id === "apply-codemods")?.label
    ).toBe("Applying changes + deps");
  });

  test("flips a step to in_progress on first call", () => {
    const store = new WizardStore();
    store.setStepStatus("ensure-sentry-project", "in_progress");
    const entry = store
      .getSnapshot()
      .steps.find((row) => row.id === "ensure-sentry-project");
    expect(entry?.status).toBe("in_progress");
  });

  test("re-entering an in_progress step is idempotent (no flicker)", () => {
    const store = new WizardStore();
    store.setStepStatus("apply-codemods", "in_progress");
    const before = store.getSnapshot().steps;
    store.setStepStatus("apply-codemods", "in_progress");
    const after = store.getSnapshot().steps;
    // Reference equality: no update emitted, so the array is the
    // same instance. This is what the store guarantees for no-op
    // mutations and what `useSyncExternalStore` relies on.
    expect(after).toBe(before);
  });

  test("back-fills earlier pending steps as skipped when a later step starts", () => {
    const store = new WizardStore();
    // Jump straight to a later step — simulates the workflow
    // taking an `if`-branch that bypassed the earlier ones.
    store.setStepStatus("verify-changes", "in_progress");
    const steps = store.getSnapshot().steps;
    const verifyIndex = CANONICAL_STEP_ORDER.indexOf("verify-changes");
    for (const entry of steps) {
      const idx = CANONICAL_STEP_ORDER.indexOf(entry.id);
      if (idx >= 0 && idx < verifyIndex) {
        expect(entry.status).toBe("skipped");
      }
    }
    expect(steps.find((entry) => entry.id === "verify-changes")?.status).toBe(
      "in_progress"
    );
  });

  test("does not back-fill steps that have already completed", () => {
    const store = new WizardStore();
    store.setStepStatus("discover-context", "in_progress");
    store.setStepStatus("discover-context", "completed");
    store.setStepStatus("verify-changes", "in_progress");
    const discover = store
      .getSnapshot()
      .steps.find((row) => row.id === "discover-context");
    expect(discover?.status).toBe("completed");
  });

  test("ignores stepIds outside the visible allowlist", () => {
    const store = new WizardStore();
    // `select-target-app` is in CANONICAL_STEP_ORDER but not in
    // CHECKLIST_VISIBLE_STEPS — the call should still drive the
    // back-fill on visible earlier rows but not add a new row.
    const initialLength = store.getSnapshot().steps.length;
    store.setStepStatus("select-target-app", "in_progress");
    // Note: variable is deliberately not named `after` because
    // Biome's `noDoneCallback` rule pattern-matches Mocha hooks
    // (`after`, `before`, …) by identifier and would flag the
    // arrow-function callback inside `.find()` below.
    const updated = store.getSnapshot().steps;
    expect(updated.length).toBe(initialLength);
    // Visible rows earlier than `select-target-app` (i.e.
    // `discover-context`) should be back-filled to skipped.
    const discover = updated.find((entry) => entry.id === "discover-context");
    expect(discover?.status).toBe("skipped");
  });

  test("completed transition wins over the existing status", () => {
    const store = new WizardStore();
    store.setStepStatus("apply-codemods", "in_progress");
    store.setStepStatus("apply-codemods", "completed");
    const entry = store
      .getSnapshot()
      .steps.find((row) => row.id === "apply-codemods");
    expect(entry?.status).toBe("completed");
  });

  test("failed transition wins over the existing status", () => {
    const store = new WizardStore();
    store.setStepStatus("apply-codemods", "in_progress");
    store.setStepStatus("apply-codemods", "failed");
    const entry = store
      .getSnapshot()
      .steps.find((row) => row.id === "apply-codemods");
    expect(entry?.status).toBe("failed");
  });

  test("explicit skipped does not overwrite a completed entry", () => {
    const store = new WizardStore();
    store.setStepStatus("discover-context", "in_progress");
    store.setStepStatus("discover-context", "completed");
    // A bogus (and impossible) explicit skip call should be a no-op.
    store.setStepStatus("discover-context", "skipped");
    const entry = store
      .getSnapshot()
      .steps.find((row) => row.id === "discover-context");
    expect(entry?.status).toBe("completed");
  });

  test("notifies subscribers on step transitions", () => {
    const store = new WizardStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.setStepStatus("apply-codemods", "in_progress");
    store.setStepStatus("apply-codemods", "in_progress"); // idempotent
    store.setStepStatus("apply-codemods", "completed");
    unsubscribe();
    // Two real transitions = two notifications. The middle no-op
    // does not fire a listener — saves a render in React.
    expect(notifications).toBe(2);
  });
});

/**
 * Cancellation callback contract.
 *
 * The Ink App reads `snapshot.requestCancel` from inside its
 * top-level `useInput` handler when no prompt is mounted (spinner
 * window). The bridge (`InkUI`) registers the callback at
 * construction and clears it on teardown so a stale Ink dispatch
 * after unmount can't re-enter cancellation.
 */
describe("WizardStore status messages", () => {
  test("starts with empty status messages", () => {
    const store = new WizardStore();
    expect(store.getSnapshot().statusMessages).toEqual([]);
    expect(store.getSnapshot().statusExpanded).toBe(false);
  });

  test("appendStatus adds messages", () => {
    const store = new WizardStore();
    store.appendStatus("Analyzing project...");
    store.appendStatus("Reading files...");
    expect(store.getSnapshot().statusMessages).toEqual([
      "Analyzing project...",
      "Reading files...",
    ]);
  });

  test("appendStatus ignores empty strings", () => {
    const store = new WizardStore();
    store.appendStatus("");
    expect(store.getSnapshot().statusMessages).toEqual([]);
  });

  test("toggleStatusExpanded flips the flag", () => {
    const store = new WizardStore();
    expect(store.getSnapshot().statusExpanded).toBe(false);
    store.toggleStatusExpanded();
    expect(store.getSnapshot().statusExpanded).toBe(true);
    store.toggleStatusExpanded();
    expect(store.getSnapshot().statusExpanded).toBe(false);
  });
});

describe("WizardStore log mutations", () => {
  test("appendLog assigns monotonically-increasing ids", () => {
    const store = new WizardStore();
    const a = store.appendLog("info", "first");
    const b = store.appendLog("warn", "second");
    const c = store.appendLog("error", "third");
    expect(b.id).toBeGreaterThan(a.id);
    expect(c.id).toBeGreaterThan(b.id);
  });

  test("appendLog stores severity and text on the entry", () => {
    const store = new WizardStore();
    const entry = store.appendLog("success", "all good");
    expect(entry.severity).toBe("success");
    expect(entry.text).toBe("all good");
  });

  test("appendLog appends to the snapshot logs array", () => {
    const store = new WizardStore();
    store.appendLog("info", "one");
    store.appendLog("error", "two");
    const { logs } = store.getSnapshot();
    expect(logs.length).toBe(2);
    expect(logs[0]?.text).toBe("one");
    expect(logs[1]?.text).toBe("two");
  });

  test("appendLog notifies subscribers", () => {
    const store = new WizardStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.appendLog("info", "msg");
    unsubscribe();
    expect(notifications).toBe(1);
  });
});

describe("WizardStore spinner lifecycle", () => {
  test("startSpinner activates the spinner, resets frame, stores message", () => {
    const store = new WizardStore();
    store.startSpinner("Loading…");
    const { spinner } = store.getSnapshot();
    expect(spinner.active).toBe(true);
    expect(spinner.frame).toBe(0);
    expect(spinner.message).toBe("Loading…");
  });

  test("tickSpinner increments frame when active", () => {
    const store = new WizardStore();
    store.startSpinner("Working");
    store.tickSpinner();
    store.tickSpinner();
    expect(store.getSnapshot().spinner.frame).toBe(2);
  });

  test("tickSpinner is a no-op when spinner is inactive", () => {
    const store = new WizardStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.tickSpinner();
    unsubscribe();
    expect(notifications).toBe(0);
    expect(store.getSnapshot().spinner.frame).toBe(0);
  });

  test("setSpinnerMessage updates message when active", () => {
    const store = new WizardStore();
    store.startSpinner("first");
    store.setSpinnerMessage("second");
    expect(store.getSnapshot().spinner.message).toBe("second");
  });

  test("setSpinnerMessage is a no-op when spinner is inactive", () => {
    const store = new WizardStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.setSpinnerMessage("ignored");
    unsubscribe();
    expect(notifications).toBe(0);
  });

  test("stopSpinner deactivates and clears message and frame", () => {
    const store = new WizardStore();
    store.startSpinner("busy");
    store.tickSpinner();
    store.stopSpinner();
    const { spinner } = store.getSnapshot();
    expect(spinner.active).toBe(false);
    expect(spinner.message).toBe("");
    expect(spinner.frame).toBe(0);
  });
});

describe("WizardStore file read state machine", () => {
  test("new paths land as reading", () => {
    const store = new WizardStore();
    store.recordFilesReading(["src/index.ts", "package.json"]);
    const { filesRead } = store.getSnapshot();
    expect(filesRead.every((e) => e.status === "reading")).toBe(true);
    expect(filesRead.map((e) => e.path)).toEqual([
      "src/index.ts",
      "package.json",
    ]);
  });

  test("recordFilesReading does not downgrade an already-analyzed entry", () => {
    const store = new WizardStore();
    store.recordFilesReading(["src/index.ts"]);
    store.markFilesAnalyzed(["src/index.ts"]);
    store.recordFilesReading(["src/index.ts"]);
    const entry = store
      .getSnapshot()
      .filesRead.find((e) => e.path === "src/index.ts");
    expect(entry?.status).toBe("analyzed");
  });

  test("markFilesAnalyzed flips reading entries to analyzed", () => {
    const store = new WizardStore();
    store.recordFilesReading(["a.ts", "b.ts"]);
    store.markFilesAnalyzed(["a.ts"]);
    const snap = store.getSnapshot();
    expect(snap.filesRead.find((e) => e.path === "a.ts")?.status).toBe(
      "analyzed"
    );
    expect(snap.filesRead.find((e) => e.path === "b.ts")?.status).toBe(
      "reading"
    );
  });

  test("markFilesAnalyzed adds unknown paths as pre-analyzed", () => {
    const store = new WizardStore();
    store.markFilesAnalyzed(["never-recorded.ts"]);
    const entry = store
      .getSnapshot()
      .filesRead.find((e) => e.path === "never-recorded.ts");
    expect(entry?.status).toBe("analyzed");
  });

  test("empty arrays are no-ops and do not notify", () => {
    const store = new WizardStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.recordFilesReading([]);
    store.markFilesAnalyzed([]);
    unsubscribe();
    expect(notifications).toBe(0);
  });
});

describe("WizardStore idempotent guards", () => {
  test("setLayout does not notify when the layout is unchanged", () => {
    const store = new WizardStore({ layout: "intro" });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.setLayout("intro");
    unsubscribe();
    expect(notifications).toBe(0);
  });

  test("setTipIndex does not notify when the index is unchanged", () => {
    const store = new WizardStore({ tipIndex: 3 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.setTipIndex(3);
    unsubscribe();
    expect(notifications).toBe(0);
  });

  test("clearOverlay does not notify when overlay is already null", () => {
    const store = new WizardStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.clearOverlay();
    unsubscribe();
    expect(notifications).toBe(0);
  });

  test("setLearnComplete does not notify when already complete", () => {
    const store = new WizardStore({
      learnState: { blockIndex: 6, lineIndex: 7, complete: true },
    });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.setLearnComplete();
    unsubscribe();
    expect(notifications).toBe(0);
  });
});

describe("WizardStore overlay lifecycle", () => {
  test("setOverlay stores the overlay and notifies", () => {
    const store = new WizardStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.setOverlay({ kind: "health", message: "Retrying…", retryCount: 1 });
    unsubscribe();
    expect(notifications).toBe(1);
    expect(store.getSnapshot().overlay).toEqual({
      kind: "health",
      message: "Retrying…",
      retryCount: 1,
    });
  });

  test("clearOverlay nulls the overlay and notifies", () => {
    const store = new WizardStore();
    store.setOverlay({ kind: "health", message: "x", retryCount: 0 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.clearOverlay();
    unsubscribe();
    expect(notifications).toBe(1);
    expect(store.getSnapshot().overlay).toBeNull();
  });
});

describe("WizardStore learn state progression", () => {
  test("advanceLearnLine increments lineIndex, leaves blockIndex unchanged", () => {
    const store = new WizardStore();
    store.advanceLearnLine();
    store.advanceLearnLine();
    const { learnState } = store.getSnapshot();
    expect(learnState.lineIndex).toBe(2);
    expect(learnState.blockIndex).toBe(0);
    expect(learnState.complete).toBe(false);
  });

  test("advanceLearnBlock increments blockIndex and resets lineIndex to 0", () => {
    const store = new WizardStore({
      learnState: { blockIndex: 1, lineIndex: 5, complete: false },
    });
    store.advanceLearnBlock();
    const { learnState } = store.getSnapshot();
    expect(learnState.blockIndex).toBe(2);
    expect(learnState.lineIndex).toBe(0);
  });

  test("advance methods are no-ops once complete", () => {
    const store = new WizardStore({
      learnState: { blockIndex: 6, lineIndex: 7, complete: true },
    });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.advanceLearnLine();
    store.advanceLearnBlock();
    store.setLearnComplete();
    unsubscribe();
    expect(notifications).toBe(0);
    expect(store.getSnapshot().learnState).toEqual({
      blockIndex: 6,
      lineIndex: 7,
      complete: true,
    });
  });
});

describe("WizardStore.prefixFor", () => {
  test("maps each LogSeverity to the correct glyph", () => {
    expect(WizardStore.prefixFor("info")).toBe("●");
    expect(WizardStore.prefixFor("warn")).toBe("▲");
    expect(WizardStore.prefixFor("error")).toBe("✖");
    expect(WizardStore.prefixFor("success")).toBe("✔");
    expect(WizardStore.prefixFor("message")).toBe(" ");
  });
});

describe("WizardStore.setRequestCancel", () => {
  test("starts undefined so an early Ctrl+C is a no-op", () => {
    const store = new WizardStore();
    expect(store.getSnapshot().requestCancel).toBeUndefined();
  });

  test("registers a callback and exposes it on the snapshot", () => {
    const store = new WizardStore();
    const cancel = () => {
      /* no-op */
    };
    store.setRequestCancel(cancel);
    expect(store.getSnapshot().requestCancel).toBe(cancel);
  });

  test("clears the callback on teardown by passing undefined", () => {
    const store = new WizardStore();
    store.setRequestCancel(() => {
      /* no-op */
    });
    store.setRequestCancel(undefined);
    expect(store.getSnapshot().requestCancel).toBeUndefined();
  });

  test("setting the same callback reference twice is a no-op", () => {
    // Avoid React re-render churn when the bridge re-registers the
    // same callback (idempotency for cheap callers).
    const store = new WizardStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    const cancel = () => {
      /* no-op */
    };
    store.setRequestCancel(cancel);
    store.setRequestCancel(cancel);
    unsubscribe();
    expect(notifications).toBe(1);
  });

  test("invocation runs the registered callback", () => {
    // The store doesn't invoke the callback itself — the App does
    // — but verify the wiring lets callers reach the function.
    const store = new WizardStore();
    let invoked = 0;
    store.setRequestCancel(() => {
      invoked += 1;
    });
    store.getSnapshot().requestCancel?.();
    expect(invoked).toBe(1);
  });
});
