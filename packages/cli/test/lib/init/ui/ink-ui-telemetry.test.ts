// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InkUI } from "../../../../src/lib/init/ui/ink-ui.js";
import {
  CANCELLED,
  type Cancelled,
} from "../../../../src/lib/init/ui/types.js";
import { WizardStore } from "../../../../src/lib/init/ui/wizard-store.js";
import { createWizardPromptTelemetry } from "../../../../src/lib/telemetry.js";

function createUi(options: { initialWelcome?: boolean } = {}): {
  ui: InkUI;
  store: WizardStore;
} {
  const store = new WizardStore();
  const instance = {
    clear: vi.fn(),
    rerender: vi.fn(),
    unmount: vi.fn(),
    waitUntilExit: vi.fn().mockResolvedValue(undefined),
  };
  if (!options.initialWelcome) {
    return { ui: new InkUI(instance, store, null), store };
  }

  let resolvePromise!: (value: "continue" | Cancelled) => void;
  const initialWelcome: {
    promise: Promise<"continue" | Cancelled>;
    tracedPromise?: Promise<"continue" | Cancelled>;
    resolve(value: "continue" | Cancelled): void;
    settled: boolean;
  } = {
    promise: new Promise<"continue" | Cancelled>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve(value: "continue" | Cancelled) {
      if (initialWelcome.settled) {
        return;
      }
      initialWelcome.settled = true;
      resolvePromise(value);
    },
    settled: false,
  };
  store.setPrompt({
    kind: "welcome",
    options: {
      title: "Welcome",
      body: ["Configure Sentry"],
      punchline: "Continue?",
    },
    resolve(value) {
      store.setPrompt(null);
      initialWelcome.resolve(value === null ? CANCELLED : value);
    },
  });
  const promptTelemetry = createWizardPromptTelemetry();
  return {
    ui: new InkUI(instance, store, null, {
      initialWelcome,
      telemetry: promptTelemetry,
    }),
    store,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InkUI prompt telemetry", () => {
  test("replaces sequential prompts without an empty frame", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { ui, store } = createUi();
    const promptKinds: Array<string | null> = [];
    const unsubscribe = store.subscribe(() => {
      promptKinds.push(store.getSnapshot().prompt?.kind ?? null);
    });

    const resultPromise = (async () => {
      await ui.multiselect({
        message: "Choose features",
        options: [{ label: "Tracing", value: "performanceMonitoring" }],
      });
      return ui.select({
        message: "Review your Sentry setup",
        options: [
          { label: "Continue", value: "continue" },
          { label: "Back", value: "back" },
        ],
      });
    })();

    const featurePrompt = store.getSnapshot().prompt;
    expect(featurePrompt?.kind).toBe("multiselect");
    if (featurePrompt?.kind !== "multiselect") {
      throw new Error("Expected a multiselect prompt");
    }
    featurePrompt.resolve(["performanceMonitoring"]);

    await vi.waitFor(() => {
      expect(store.getSnapshot().prompt?.kind).toBe("select");
    });
    expect(promptKinds).toEqual(["multiselect", "select"]);

    const reviewPrompt = store.getSnapshot().prompt;
    if (reviewPrompt?.kind !== "select") {
      throw new Error("Expected a select prompt");
    }
    reviewPrompt.resolve("continue");
    await expect(resultPromise).resolves.toBe("continue");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(promptKinds).toEqual(["multiselect", "select", null]);

    unsubscribe();
    await ui[Symbol.asyncDispose]();
  });

  test("returns from review to feature selection without an empty frame", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { ui, store } = createUi();
    const promptKinds: Array<string | null> = [];
    const unsubscribe = store.subscribe(() => {
      promptKinds.push(store.getSnapshot().prompt?.kind ?? null);
    });

    const resultPromise = (async () => {
      await ui.select({
        message: "Review your Sentry setup",
        options: [
          { label: "Continue", value: "continue" },
          { label: "Back", value: "back" },
        ],
      });
      return ui.multiselect({
        message: "Choose features",
        options: [{ label: "Tracing", value: "performanceMonitoring" }],
      });
    })();

    const reviewPrompt = store.getSnapshot().prompt;
    expect(reviewPrompt?.kind).toBe("select");
    if (reviewPrompt?.kind !== "select") {
      throw new Error("Expected a select prompt");
    }
    reviewPrompt.resolve("back");

    await vi.waitFor(() => {
      expect(store.getSnapshot().prompt?.kind).toBe("multiselect");
    });
    expect(promptKinds).toEqual(["select", "multiselect"]);

    const featurePrompt = store.getSnapshot().prompt;
    if (featurePrompt?.kind !== "multiselect") {
      throw new Error("Expected a multiselect prompt");
    }
    featurePrompt.resolve(["performanceMonitoring"]);
    await expect(resultPromise).resolves.toEqual(["performanceMonitoring"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(promptKinds).toEqual(["select", "multiselect", null]);

    unsubscribe();
    await ui[Symbol.asyncDispose]();
  });

  test("replaces the completed review atomically with planning progress", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { ui, store } = createUi();
    const states: Array<{
      prompt: string | null;
      spinnerActive: boolean;
      spinnerMessage: string;
    }> = [];
    const unsubscribe = store.subscribe(() => {
      const snapshot = store.getSnapshot();
      states.push({
        prompt: snapshot.prompt?.kind ?? null,
        spinnerActive: snapshot.spinner.active,
        spinnerMessage: snapshot.spinner.message,
      });
    });

    const resultPromise = (async () => {
      const result = await ui.select({
        message: "Review your Sentry setup",
        options: [
          { label: "Continue", value: "continue" },
          { label: "Back", value: "back" },
        ],
      });
      ui.spinner().start("Planning code changes...");
      return result;
    })();

    const reviewPrompt = store.getSnapshot().prompt;
    if (reviewPrompt?.kind !== "select") {
      throw new Error("Expected a select prompt");
    }
    reviewPrompt.resolve("continue");

    await vi.waitFor(() => {
      expect(store.getSnapshot().spinner.active).toBe(true);
    });
    await expect(resultPromise).resolves.toBe("continue");
    expect(states).not.toContainEqual(
      expect.objectContaining({ prompt: null, spinnerActive: false })
    );
    expect(states).not.toContainEqual(
      expect.objectContaining({ prompt: "select", spinnerActive: true })
    );
    expect(store.getSnapshot()).toMatchObject({
      prompt: null,
      spinner: {
        active: true,
        message: "Planning code changes...",
      },
    });

    unsubscribe();
    await ui[Symbol.asyncDispose]();
  });

  test.each([
    "select",
    "multiselect",
  ] as const)("clears a cancelled %s prompt after returning the cancellation", async (kind) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { ui, store } = createUi();
    const promptKinds: Array<string | null> = [];
    const unsubscribe = store.subscribe(() => {
      promptKinds.push(store.getSnapshot().prompt?.kind ?? null);
    });

    const resultPromise =
      kind === "select"
        ? ui.select({
            message: "Review your Sentry setup",
            options: [{ label: "Continue", value: "continue" }],
          })
        : ui.multiselect({
            message: "Choose features",
            options: [{ label: "Tracing", value: "performanceMonitoring" }],
          });
    const prompt = store.getSnapshot().prompt;
    expect(prompt?.kind).toBe(kind);
    if (prompt?.kind !== "select" && prompt?.kind !== "multiselect") {
      throw new Error(`Expected a ${kind} prompt`);
    }

    prompt.resolve(null);
    await expect(resultPromise).resolves.toBe(CANCELLED);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.getSnapshot().prompt).toBeNull();
    expect(promptKinds).toEqual([kind, null]);

    unsubscribe();
    await ui[Symbol.asyncDispose]();
  });

  test("attributes workflow prompts to the active step", async () => {
    const metricSpy = vi.spyOn(Sentry.metrics, "distribution");
    const startSpanSpy = vi.spyOn(Sentry, "startSpan");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { ui, store } = createUi();

    ui.setStep("select-features", "in_progress");
    const resultPromise = ui.multiselect({
      message: "Choose features",
      options: [{ label: "Tracing", value: "performanceMonitoring" }],
    });
    const prompt = store.getSnapshot().prompt;
    expect(prompt?.kind).toBe("multiselect");
    if (prompt?.kind !== "multiselect") {
      throw new Error("Expected a multiselect prompt");
    }
    prompt.resolve(["performanceMonitoring"]);

    await expect(resultPromise).resolves.toEqual(["performanceMonitoring"]);
    expect(metricSpy).toHaveBeenCalledWith(
      "wizard.user_wait_ms",
      expect.any(Number),
      {
        attributes: {
          prompt_kind: "multiselect",
          workflow_step: "select-features",
        },
      }
    );
    expect(startSpanSpy).toHaveBeenCalledWith(
      {
        name: "wizard.prompt.multiselect",
        op: "ui.prompt",
        onlyIfParent: true,
        attributes: {
          "wizard.prompt.kind": "multiselect",
          "wizard.prompt.phase": "workflow",
          "wizard.step.id": "select-features",
        },
      },
      expect.any(Function)
    );

    await ui[Symbol.asyncDispose]();
  });

  test("records the welcome prompt as preflight rather than a workflow step", async () => {
    const metricSpy = vi.spyOn(Sentry.metrics, "distribution");
    const startSpanSpy = vi.spyOn(Sentry, "startSpan");
    let now = 100;
    vi.spyOn(globalThis.performance, "now").mockImplementation(() => now);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { ui, store } = createUi({ initialWelcome: true });

    expect(startSpanSpy).toHaveBeenCalledTimes(1);
    const prompt = store.getSnapshot().prompt;
    expect(prompt?.kind).toBe("welcome");
    if (prompt?.kind !== "welcome") {
      throw new Error("Expected a welcome prompt");
    }
    now = 150;
    prompt.resolve("continue");
    const resultPromise = ui.welcome({
      title: "Welcome",
      body: ["Configure Sentry"],
      punchline: "Continue?",
    });

    await expect(resultPromise).resolves.toBe("continue");
    expect(metricSpy).toHaveBeenCalledWith("wizard.user_wait_ms", 50, {
      attributes: { prompt_kind: "welcome" },
    });
    expect(startSpanSpy).toHaveBeenCalledWith(
      {
        name: "wizard.prompt.welcome",
        op: "ui.prompt",
        onlyIfParent: true,
        attributes: {
          "wizard.prompt.kind": "welcome",
          "wizard.prompt.phase": "preflight",
        },
      },
      expect.any(Function)
    );
    expect(startSpanSpy).toHaveBeenCalledTimes(1);

    await ui[Symbol.asyncDispose]();
  });
});
