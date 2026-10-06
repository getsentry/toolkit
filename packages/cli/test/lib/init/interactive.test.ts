/**
 * Interactive Dispatcher Tests
 *
 * Tests for the init wizard interactive prompt handlers. Uses a
 * `MockUI` that records calls and replays canned prompt responses, so
 * the dispatcher can be exercised without touching clack or any real
 * terminal.
 */

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WizardError } from "../../../src/lib/errors.js";
import { handleInteractive } from "../../../src/lib/init/interactive.js";
import type { InteractiveContext } from "../../../src/lib/init/types.js";
import { CANCELLED } from "../../../src/lib/init/ui/types.js";
import { createMockUI } from "./ui/mock-ui.js";

function makeOptions(
  overrides?: Partial<InteractiveContext>
): InteractiveContext {
  return {
    yes: false,
    dryRun: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleInteractive dispatcher", () => {
  test("throws WizardError for unknown kind", async () => {
    const { ui } = createMockUI();
    await expect(
      handleInteractive(
        { type: "interactive", prompt: "test", kind: "unknown" as "select" },
        makeOptions(),
        ui
      )
    ).rejects.toBeInstanceOf(WizardError);
  });
});

describe("handleSelect", () => {
  test("auto-selects single option with --yes", async () => {
    const { ui, calls } = createMockUI();
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Choose app",
        kind: "select",
        options: ["my-app"],
      },
      makeOptions({ yes: true }),
      ui
    );

    expect(result).toEqual({ selectedApp: "my-app" });
    expect(
      calls.some((c) => c.kind === "log.info" && c.message.includes("my-app"))
    ).toBe(true);
  });

  test("throws WizardError with app list when --yes and multiple apps", async () => {
    const { ui, calls } = createMockUI();
    await expect(
      handleInteractive(
        {
          type: "interactive",
          prompt: "Choose app",
          kind: "select",
          apps: [
            { name: "react", path: "/repo/apps/react" },
            { name: "vue", path: "/repo/apps/vue" },
          ],
        },
        makeOptions({ yes: true }),
        ui
      )
    ).rejects.toBeInstanceOf(WizardError);
    expect(calls.some((c) => c.kind === "log.error")).toBe(true);
  });

  test("falls through to ui.select when --yes and non-monorepo select", async () => {
    // --yes must not throw the monorepo error for select prompts that have
    // no payload.apps — only app-selection prompts provide that array.
    const { ui, respond } = createMockUI();
    respond.select("create");
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Found an existing project.",
        kind: "select",
        options: ["existing", "create"],
      },
      makeOptions({ yes: true }),
      ui
    );
    expect(result).toEqual({ selectedApp: "create" });
  });

  test("throws WizardError when options list is empty", async () => {
    const { ui } = createMockUI();
    await expect(
      handleInteractive(
        {
          type: "interactive",
          prompt: "Choose app",
          kind: "select",
          options: [],
        },
        makeOptions(),
        ui
      )
    ).rejects.toBeInstanceOf(WizardError);
  });

  test("uses apps array names when options not provided", async () => {
    const { ui } = createMockUI();
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Choose app",
        kind: "select",
        apps: [{ name: "express-app", path: "/app", framework: "Express" }],
      },
      makeOptions({ yes: true }),
      ui
    );

    expect(result).toEqual({ selectedApp: "express-app" });
  });

  test("calls ui.select in interactive mode", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.select("vue");

    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Choose app",
        kind: "select",
        options: ["react", "vue"],
      },
      makeOptions({ yes: false }),
      ui
    );

    expect(result).toEqual({ selectedApp: "vue" });
    expect(calls.some((c) => c.kind === "select")).toBe(true);
  });

  test("throws WizardCancelledError on user cancellation", async () => {
    const { ui, respond } = createMockUI();
    respond.select(CANCELLED);

    await expect(
      handleInteractive(
        {
          type: "interactive",
          prompt: "Choose app",
          kind: "select",
          options: ["react", "vue"],
        },
        makeOptions({ yes: false }),
        ui
      )
    ).rejects.toThrow("Setup cancelled");
  });
});

describe("handleSelect with --app flag", () => {
  test("selects matching app by name", async () => {
    const { ui, calls } = createMockUI();
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select the target application:",
        kind: "select",
        apps: [
          { name: "web", path: "/repo/apps/web", framework: "Next.js" },
          { name: "api", path: "/repo/apps/api", framework: "Express" },
        ],
      },
      makeOptions({ yes: true, app: "web" }),
      ui
    );

    expect(result).toEqual({ selectedApp: "web" });
    expect(
      calls.some((c) => c.kind === "log.info" && c.message.includes("web"))
    ).toBe(true);
  });

  test("matches --app case-insensitively", async () => {
    const { ui } = createMockUI();
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select the target application:",
        kind: "select",
        apps: [{ name: "Web", path: "/repo/apps/web" }],
      },
      makeOptions({ app: "WEB" }),
      ui
    );

    expect(result).toEqual({ selectedApp: "Web" });
  });

  test("throws WizardError when --app name is not found", async () => {
    const { ui, calls } = createMockUI();
    await expect(
      handleInteractive(
        {
          type: "interactive",
          prompt: "Select the target application:",
          kind: "select",
          apps: [
            { name: "web", path: "/repo/apps/web" },
            { name: "api", path: "/repo/apps/api" },
          ],
        },
        makeOptions({ yes: true, app: "missing" }),
        ui
      )
    ).rejects.toBeInstanceOf(WizardError);
    const errorCall = calls.find((c) => c.kind === "log.error");
    expect(errorCall?.message).toContain("missing");
    expect(errorCall?.message).toContain("web");
  });

  test("ignores --app when payload has no apps array", async () => {
    // --app only activates for monorepo app-selection prompts (payload.apps present).
    // For other select prompts it must fall through to the normal interactive pick.
    const { ui, respond } = createMockUI();
    respond.select("existing");
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Found an existing project.",
        kind: "select",
        options: ["existing", "create"],
      },
      makeOptions({ app: "web" }),
      ui
    );

    expect(result).toEqual({ selectedApp: "existing" });
  });

  test("error message for --yes with multiple apps includes app names and --app hint", async () => {
    const { ui, calls } = createMockUI();
    await expect(
      handleInteractive(
        {
          type: "interactive",
          prompt: "Select the target application:",
          kind: "select",
          apps: [
            { name: "web", path: "/repo/apps/web", framework: "Next.js" },
            { name: "api", path: "/repo/apps/api" },
          ],
        },
        makeOptions({ yes: true }),
        ui
      )
    ).rejects.toBeInstanceOf(WizardError);
    const errorCall = calls.find((c) => c.kind === "log.error");
    expect(errorCall?.message).toContain("web");
    expect(errorCall?.message).toContain("api");
    expect(errorCall?.message).toContain("--app");
  });
});

describe("handleMultiSelect", () => {
  test("records offered and selected features for interactive prompts", async () => {
    const setTagSpy = vi.spyOn(Sentry, "setTag");
    const { ui, respond } = createMockUI();
    respond.multiselect(["sessionReplay"]);
    respond.select("continue");

    await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: [
          "errorMonitoring",
          "performanceMonitoring",
          "sessionReplay",
          "userFeedback",
        ],
      },
      makeOptions(),
      ui
    );

    expect(setTagSpy).toHaveBeenCalledWith(
      "wizard.features.offered",
      "errorMonitoring,performanceMonitoring,sessionReplay"
    );
    expect(setTagSpy).toHaveBeenCalledWith(
      "wizard.features.selected",
      "errorMonitoring,sessionReplay"
    );
  });

  test("auto-selects all features with --yes", async () => {
    const { ui } = createMockUI();
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: [
          "errorMonitoring",
          "performanceMonitoring",
          "sessionReplay",
          "userFeedback",
        ],
      },
      makeOptions({ yes: true }),
      ui
    );

    expect(result.features).toEqual([
      "errorMonitoring",
      "performanceMonitoring",
      "sessionReplay",
    ]);
  });

  test("returns error monitoring when no features are provided", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.multiselect([]);
    respond.select("continue");
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: [],
      },
      makeOptions(),
      ui
    );

    expect(result).toEqual({ features: ["errorMonitoring"] });
    expect(calls.some((call) => call.kind === "multiselect")).toBe(true);
    expect(calls.some((call) => call.kind === "select")).toBe(true);
  });

  test("injects error monitoring when the server omits the baseline", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.multiselect(["sessionReplay"]);
    respond.select("continue");

    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: ["sessionReplay", "performanceMonitoring"],
      },
      makeOptions(),
      ui
    );

    expect(result).toEqual({
      features: ["errorMonitoring", "sessionReplay"],
    });
    const multiselectCall = calls.find((call) => call.kind === "multiselect");
    expect(multiselectCall?.options).toContain("errorMonitoring");
  });

  test("prepends errorMonitoring when available but not user-selected", async () => {
    // User selects only sessionReplay, but errorMonitoring is available (required)
    const { ui, respond } = createMockUI();
    respond.multiselect(["sessionReplay"]);
    respond.select("continue");

    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: [
          "errorMonitoring",
          "performanceMonitoring",
          "sessionReplay",
        ],
      },
      makeOptions({ yes: false }),
      ui
    );

    const features = result.features as string[];
    expect(features[0]).toBe("errorMonitoring");
    expect(features).toContain("sessionReplay");
  });

  test("throws WizardCancelledError when user cancels multi-select", async () => {
    const setTagSpy = vi.spyOn(Sentry, "setTag");
    const { ui, respond } = createMockUI();
    respond.multiselect(CANCELLED);

    await expect(
      handleInteractive(
        {
          type: "interactive",
          prompt: "Select features",
          kind: "multi-select",
          availableFeatures: ["errorMonitoring", "performanceMonitoring"],
        },
        makeOptions({ yes: false }),
        ui
      )
    ).rejects.toThrow("Setup cancelled");
    expect(setTagSpy).toHaveBeenCalledWith(
      "wizard.features.offered",
      "errorMonitoring,performanceMonitoring"
    );
    expect(setTagSpy).not.toHaveBeenCalledWith(
      "wizard.features.selected",
      expect.anything()
    );
  });

  test("shows selection and review when only errorMonitoring is available", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.multiselect([]);
    respond.select("continue");
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: ["errorMonitoring"],
      },
      makeOptions({ yes: false }),
      ui
    );

    expect(result).toEqual({ features: ["errorMonitoring"] });
    const multiselectCall = calls.find((call) => call.kind === "multiselect");
    expect(multiselectCall?.options).toEqual(["errorMonitoring"]);
    expect(multiselectCall?.initialValues).toEqual(["errorMonitoring"]);
    const reviewCall = calls.find((call) => call.kind === "select");
    expect(reviewCall?.details?.map((detail) => detail.text)).toContain(
      "✓ Error Monitoring"
    );
  });

  test("shows errorMonitoring as a locked selected option", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.multiselect(["performanceMonitoring"]);
    respond.select("continue");

    await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: ["errorMonitoring", "performanceMonitoring"],
      },
      makeOptions({ yes: false }),
      ui
    );

    const multiselectCall = calls.find((c) => c.kind === "multiselect") as
      | Extract<(typeof calls)[number], { kind: "multiselect" }>
      | undefined;
    expect(multiselectCall).toBeDefined();
    expect(multiselectCall?.options).toContain("errorMonitoring");
    expect(multiselectCall?.options).toContain("performanceMonitoring");
    expect(multiselectCall?.initialValues).toEqual([
      "errorMonitoring",
      "performanceMonitoring",
    ]);
    expect(
      multiselectCall?.optionDetails.find(
        (option) => option.value === "errorMonitoring"
      )
    ).toMatchObject({
      description: "Automatically capture exceptions and stack traces",
      locked: true,
    });
  });

  test("shows defaults first, sorts optional features, and omits unsupported features", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.multiselect(["sessionReplay"]);
    respond.select("continue");

    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: [
          "sourceMaps",
          "profiling",
          "performanceMonitoring",
          "errorMonitoring",
          "metrics",
          "sessionReplay",
          "logs",
          "crons",
          "attachments",
          "aiMonitoring",
          "mcpObservability",
          "userFeedback",
        ],
      },
      makeOptions({ yes: false }),
      ui
    );

    expect(result.features).toEqual(["errorMonitoring", "sessionReplay"]);

    const multiselectCall = calls.find((c) => c.kind === "multiselect") as
      | Extract<(typeof calls)[number], { kind: "multiselect" }>
      | undefined;
    expect(multiselectCall?.options).toEqual([
      "errorMonitoring",
      "logs",
      "sessionReplay",
      "performanceMonitoring",
      "aiMonitoring",
      "crons",
      "mcpObservability",
      "profiling",
      "sourceMaps",
    ]);
    expect(multiselectCall?.initialValues).toEqual([
      "errorMonitoring",
      "logs",
      "sessionReplay",
      "performanceMonitoring",
    ]);
    expect(multiselectCall?.details).toEqual([
      {
        text: "Based on your project, these features are available to set up.",
      },
    ]);
    expect(multiselectCall?.options).not.toContain("metrics");
    expect(multiselectCall?.options).not.toContain("attachments");
    expect(multiselectCall?.options).not.toContain("userFeedback");

    const reviewCall = calls.find((call) => call.kind === "select");
    expect(reviewCall?.details?.[0]).toEqual({
      text: "We'll add these features:",
    });
    expect(reviewCall?.footer).toEqual({
      text: "We'll modify project files for this Sentry setup.",
    });
  });

  test("can go back from review and preserves the explicit selection", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.multiselect(["sessionReplay"]);
    respond.select("back");
    respond.multiselect(["performanceMonitoring"]);
    respond.select("continue");

    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: [
          "errorMonitoring",
          "performanceMonitoring",
          "sessionReplay",
        ],
      },
      makeOptions(),
      ui
    );

    expect(result).toEqual({
      features: ["errorMonitoring", "performanceMonitoring"],
    });
    const multiselectCalls = calls.filter(
      (call) => call.kind === "multiselect"
    );
    expect(multiselectCalls).toHaveLength(2);
    expect(multiselectCalls[1]?.initialValues).toEqual([
      "errorMonitoring",
      "sessionReplay",
    ]);
    const reviewCalls = calls.filter((call) => call.kind === "select");
    expect(reviewCalls[0]?.details?.map((detail) => detail.text)).toContain(
      "✓ Session Replay"
    );
    expect(reviewCalls[0]?.details?.map((detail) => detail.text)).not.toContain(
      "✓ Tracing"
    );
    expect(
      reviewCalls[0]?.details
        ?.map((detail) => detail.text)
        .filter((line) => line.startsWith("✓ "))
    ).toEqual(["✓ Error Monitoring", "✓ Session Replay"]);
    expect(reviewCalls[1]?.details?.map((detail) => detail.text)).toContain(
      "✓ Tracing"
    );
    expect(reviewCalls[1]?.options).toEqual(["continue", "back"]);
  });

  test.each([
    ["aiMonitoring", "Agent Tracing"],
    ["mcpObservability", "MCP Observability"],
    ["profiling", "Profiling"],
  ])("review includes tracing when %s enables it implicitly", async (dependencyFeature, dependencyLabel) => {
    const { ui, calls, respond } = createMockUI();
    respond.multiselect([dependencyFeature]);
    respond.select("continue");

    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: [
          "errorMonitoring",
          "performanceMonitoring",
          dependencyFeature,
        ],
      },
      makeOptions(),
      ui
    );

    expect(result).toEqual({
      features: ["errorMonitoring", "performanceMonitoring", dependencyFeature],
    });
    const reviewCall = calls.find((call) => call.kind === "select");
    const reviewDetails = reviewCall?.details?.map((detail) => detail.text);
    expect(reviewDetails).toContain("✓ Error Monitoring");
    expect(reviewDetails).toContain("✓ Tracing");
    expect(reviewDetails).toContain(`✓ ${dependencyLabel}`);
  });

  test("Back restores the normalized AI selection including Tracing", async () => {
    const { ui, calls, respond } = createMockUI();
    respond.multiselect(["aiMonitoring"]);
    respond.select("back");
    respond.multiselect(["aiMonitoring", "performanceMonitoring"]);
    respond.select("continue");

    await handleInteractive(
      {
        type: "interactive",
        prompt: "Select features",
        kind: "multi-select",
        availableFeatures: [
          "errorMonitoring",
          "performanceMonitoring",
          "aiMonitoring",
        ],
      },
      makeOptions(),
      ui
    );

    const multiselectCalls = calls.filter(
      (call) => call.kind === "multiselect"
    );
    expect(multiselectCalls[1]?.initialValues).toEqual([
      "errorMonitoring",
      "performanceMonitoring",
      "aiMonitoring",
    ]);
  });
});

describe("handleConfirm", () => {
  test("auto-confirms with action: continue for non-example prompts with --yes", async () => {
    const { ui } = createMockUI();
    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Continue with setup?",
        kind: "confirm",
      },
      makeOptions({ yes: true }),
      ui
    );

    expect(result).toEqual({ action: "continue" });
  });

  test("throws WizardCancelledError when user cancels confirm", async () => {
    const { ui, respond } = createMockUI();
    respond.confirm(CANCELLED);

    await expect(
      handleInteractive(
        {
          type: "interactive",
          prompt: "Continue with setup?",
          kind: "confirm",
        },
        makeOptions({ yes: false }),
        ui
      )
    ).rejects.toThrow("Setup cancelled");
  });

  test("returns action: stop when user declines non-example prompt", async () => {
    const { ui, respond } = createMockUI();
    respond.confirm(false);

    const result = await handleInteractive(
      {
        type: "interactive",
        prompt: "Continue with setup?",
        kind: "confirm",
      },
      makeOptions({ yes: false }),
      ui
    );

    expect(result).toEqual({ action: "stop" });
  });
});
