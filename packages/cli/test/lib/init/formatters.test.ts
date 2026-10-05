/**
 * Formatters Tests
 *
 * Tests for the init wizard output formatters. Uses `MockUI` to capture
 * every UI call.
 *
 * The previous implementation pushed pre-rendered markdown through
 * `ui.log.message`; these tests asserted on raw markdown strings. The
 * new implementation hands a structured `WizardSummary` to
 * `ui.summary()`, so the assertions look at fields and changedFiles
 * instead of rendered markup.
 */

import { describe, expect, test } from "vitest";
import { formatError, formatResult } from "../../../src/lib/init/formatters.js";
import type { WizardSummary } from "../../../src/lib/init/ui/types.js";
import { createMockUI, type MockCall } from "./ui/mock-ui.js";

function summaryCall(calls: MockCall[]): WizardSummary | undefined {
  const call = calls.find((c) => c.kind === "summary");
  return call?.kind === "summary" ? call.summary : undefined;
}

function warnMessages(calls: MockCall[]): string[] {
  return calls
    .filter(
      (c): c is Extract<MockCall, { kind: "log.warn" }> => c.kind === "log.warn"
    )
    .map((c) => c.message);
}

function errorMessages(calls: MockCall[]): string[] {
  return calls
    .filter(
      (c): c is Extract<MockCall, { kind: "log.error" }> =>
        c.kind === "log.error"
    )
    .map((c) => c.message);
}

function infoMessages(calls: MockCall[]): string[] {
  return calls
    .filter(
      (c): c is Extract<MockCall, { kind: "log.info" }> => c.kind === "log.info"
    )
    .map((c) => c.message);
}

function feedbackOutcomes(calls: MockCall[]): string[] {
  return calls
    .filter(
      (c): c is Extract<MockCall, { kind: "feedback" }> => c.kind === "feedback"
    )
    .map((c) => c.outcome);
}

describe("formatResult", () => {
  test("emits a structured summary with all fields and the changed-files list", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          projectDir: "/app",
          features: ["errorMonitoring", "performanceMonitoring"],
          commands: ["npm install @sentry/nextjs"],
          sentryProjectUrl: "https://sentry.io/project",
          docsUrl: "https://docs.sentry.io",
          changedFiles: [
            { action: "modify", path: "next.config.js" },
            { action: "create", path: "src/app/instrumentation-client.ts" },
            { action: "modify", path: "src/app/layout.tsx" },
            { action: "delete", path: "src/old-sentry.js" },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary).toBeDefined();
    if (!summary) {
      throw new Error("expected summary call");
    }

    // Field order matches the source iteration in `buildSummary`.
    expect(summary.fields).toEqual([
      { label: "Platform", value: "Next.js" },
      { label: "Directory", value: "/app" },
      {
        label: "Features",
        value: "Error Monitoring, Tracing",
      },
      { label: "Commands", value: "npm install @sentry/nextjs" },
      { label: "Project", value: "https://sentry.io/project" },
      { label: "Docs", value: "https://docs.sentry.io" },
    ]);
    expect(summary.changedFiles).toEqual([
      { action: "modify", path: "next.config.js" },
      { action: "create", path: "src/app/instrumentation-client.ts" },
      { action: "modify", path: "src/app/layout.tsx" },
      { action: "delete", path: "src/old-sentry.js" },
    ]);
    expect(feedbackOutcomes(calls)).toEqual(["success"]);
    expect(
      infoMessages(calls).some((message) =>
        message.includes("one of the first")
      )
    ).toBe(false);
  });

  test("skips the summary call when result has no summary-worthy fields", () => {
    const { ui, calls } = createMockUI();
    formatResult({ status: "success" }, ui);

    expect(summaryCall(calls)).toBeUndefined();
    expect(calls.some((c) => c.kind === "outro")).toBe(true);
  });

  test("displays warnings when present", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          warnings: ["Source maps not configured", "Missing DSN"],
        },
      },
      ui
    );

    const warns = warnMessages(calls);
    expect(warns).toContain("Source maps not configured");
    expect(warns).toContain("Missing DSN");
  });

  test("unwraps nested result property", () => {
    const { ui, calls } = createMockUI();
    formatResult({ status: "success", result: { platform: "React" } }, ui);

    const summary = summaryCall(calls);
    expect(summary?.fields).toContainEqual({
      label: "Platform",
      value: "React",
    });
  });

  test("omits changedFiles when empty", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "React",
          changedFiles: [],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary).toBeDefined();
    expect(summary?.changedFiles).toBeUndefined();
  });

  test("emits a summary with only changedFiles when no fields are populated", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          changedFiles: [{ action: "create", path: "instrument.ts" }],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.fields).toEqual([]);
    expect(summary?.changedFiles).toEqual([
      { action: "create", path: "instrument.ts" },
    ]);
    // The structured completion payload is always attached for the InkUI
    // completion screen; its internals are covered by dedicated tests.
    expect(summary?.completion).toBeDefined();
  });
});

describe("formatResult completion payload", () => {
  test("builds the Issues-stream URL, MCP endpoint, and next-step metadata", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "next.js",
          projectDir: "/work/my-app",
          features: ["errorMonitoring", "performanceMonitoring"],
          commands: ["pnpm add @sentry/nextjs"],
          orgSlug: "acme",
          projectSlug: "my-app",
          projectId: "4507",
          docsUrl: "https://docs.sentry.io/platforms/javascript/guides/nextjs/",
          changedFiles: [{ action: "create", path: "instrument.ts" }],
        },
      },
      ui
    );

    const completion = summaryCall(calls)?.completion;
    expect(completion).toBeDefined();
    // Primary CTA points at the project-scoped Issues stream, not settings.
    expect(completion?.issuesUrl).toContain("/issues/?project=4507");
    expect(completion?.issuesUrl).toContain("acme");
    expect(completion?.projectName).toBe("my-app");
    expect(completion?.features).toHaveLength(2);
    expect(completion?.changedFileCount).toBe(1);
    expect(completion?.agentInstallCommand).toBe("npx @sentry/ai install");
    expect(completion?.startCommand).toBe("pnpm dev");
    expect(completion?.verification).toEqual({ received: false });
  });

  test("a verified event deep-links the exact event", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: { orgSlug: "acme", projectSlug: "my-app", projectId: "4507" },
      },
      ui,
      { verified: true, kind: "envelope", eventId: "abc123def" }
    );

    const completion = summaryCall(calls)?.completion;
    expect(completion?.verification.received).toBe(true);
    expect(completion?.verification.eventUrl).toContain("event.id:abc123def");
  });

  test("recovers the org from the settings URL when the server omits slugs", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "python",
          // Older server: only the settings URL, no orgSlug.
          sentryProjectUrl: "https://acme.sentry.io/settings/projects/api/",
        },
      },
      ui
    );

    const completion = summaryCall(calls)?.completion;
    // Issues stream is recovered from the settings URL's org.
    expect(completion?.issuesUrl).toBe("https://acme.sentry.io/issues/");
  });

  test("keeps the raw project URL only when the org can't be recovered", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: { platform: "python", sentryProjectUrl: "not-a-url" },
      },
      ui
    );

    const completion = summaryCall(calls)?.completion;
    expect(completion?.issuesUrl).toBe("not-a-url");
  });
});

describe("formatResult with locally-captured project identity", () => {
  // The CLI creates the Sentry project itself, so it captures the identity from
  // the create-sentry-project tool result and passes it as the 4th arg. This is
  // now the primary source of org/project/projectId in prod — the server no
  // longer echoes them back (cli-init-api#239 closed).
  const identity = {
    orgSlug: "acme",
    projectSlug: "my-app",
    projectId: "4507",
    dsn: "https://k@o0.ingest.sentry.io/4507",
    url: "https://acme.sentry.io/settings/projects/my-app/",
  };

  test("builds the Issues link from the captured identity when the server sends no slugs", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: { platform: "next.js", commands: ["pnpm add @sentry/nextjs"] },
      },
      ui,
      undefined,
      identity
    );

    const completion = summaryCall(calls)?.completion;
    expect(completion?.issuesUrl).toBe(
      "https://acme.sentry.io/issues/?project=4507"
    );
    expect(completion?.projectName).toBe("my-app");
  });

  test("captured identity takes precedence over stale server-echoed slugs", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "next.js",
          orgSlug: "stale-org",
          projectSlug: "stale-project",
          projectId: "9999",
        },
      },
      ui,
      undefined,
      identity
    );

    const completion = summaryCall(calls)?.completion;
    expect(completion?.projectName).toBe("my-app");
    expect(completion?.issuesUrl).toContain("acme");
    expect(completion?.issuesUrl).toContain("project=4507");
    expect(completion?.issuesUrl).not.toContain("stale");
  });

  test("backfills the summary Project field from the captured identity URL", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      { status: "success", result: { platform: "next.js" } },
      ui,
      undefined,
      identity
    );

    const summary = summaryCall(calls);
    expect(summary?.fields).toContainEqual({
      label: "Project",
      value: "https://acme.sentry.io/settings/projects/my-app/",
    });
  });

  test("drops the dry-run sentinel projectId instead of leaking ?project=(dry-run)", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      { status: "success", result: { platform: "next.js" } },
      ui,
      undefined,
      {
        orgSlug: "acme",
        projectSlug: "my-app",
        projectId: "(dry-run)",
        url: "https://sentry.io/dry-run",
      }
    );

    const completion = summaryCall(calls)?.completion;
    // Non-numeric id is dropped → org-wide, unfiltered Issues stream.
    expect(completion?.issuesUrl).toBe("https://acme.sentry.io/issues/");
    expect(completion?.issuesUrl).not.toContain("(dry-run)");
  });
});

describe("formatResult with featureBlurbs", () => {
  test("populates featureBlurbs from output.featureBlurbs paired positionally with output.features", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          projectDir: "/app",
          features: ["errorMonitoring", "performanceMonitoring"],
          featureBlurbs: [
            { feature: "errorMonitoring", blurb: "Captures exceptions." },
            { feature: "performanceMonitoring", blurb: "Traces requests." },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.featureBlurbs).toEqual([
      { label: "Error Monitoring", blurb: "Captures exceptions." },
      { label: "Tracing", blurb: "Traces requests." },
    ]);
  });

  test("suppresses the Features row when featureBlurbs are present", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: ["errorMonitoring"],
          featureBlurbs: [
            { feature: "errorMonitoring", blurb: "Captures exceptions." },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.fields.some((f) => f.label === "Features")).toBe(false);
  });

  test("shows the Features row when featureBlurbs are absent", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: ["errorMonitoring", "sessionReplay"],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.fields.some((f) => f.label === "Features")).toBe(true);
  });

  test("regression: all blurbs render when server returns canonical feature IDs", () => {
    // Regression for the 'only Tracing' bug: the LLM was echoing human-readable
    // labels ("Error Monitoring") in the feature field instead of canonical IDs
    // ("errorMonitoring"). The server-side fix now maps blurbs positionally so
    // canonical IDs are always in the feature field. This test verifies the CLI
    // renders all blurbs when the server returns canonical IDs correctly — not
    // just the one feature that happened to have a matching ID.
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: [
            "errorMonitoring",
            "performanceMonitoring",
            "sessionReplay",
          ],
          featureBlurbs: [
            { feature: "errorMonitoring", blurb: "Captures exceptions." },
            { feature: "performanceMonitoring", blurb: "Traces requests." },
            { feature: "sessionReplay", blurb: "Records sessions." },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.featureBlurbs).toHaveLength(3);
    expect(summary?.featureBlurbs?.map((b) => b.label)).toEqual([
      "Error Monitoring",
      "Session Replay",
      "Tracing",
    ]);
  });

  test("labels use canonical feature IDs — agent echoing wrong IDs omits the blurb rather than mislabelling", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: ["errorMonitoring", "sessionReplay"],
          // Agent echoed back wrong IDs — neither matches a canonical feature
          featureBlurbs: [
            { feature: "error_monitoring", blurb: "Blurb A." },
            { feature: "session-replay", blurb: "Blurb B." },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    // Wrong IDs → no match → blurbs omitted entirely; safe fallback
    expect(summary?.featureBlurbs).toBeUndefined();
  });

  test("drops blurb for feature the agent omitted — remaining blurbs stay correctly labelled", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: [
            "errorMonitoring",
            "performanceMonitoring",
            "sessionReplay",
          ],
          // Agent returned 2 of 3; skipped performanceMonitoring
          featureBlurbs: [
            { feature: "errorMonitoring", blurb: "Captures." },
            { feature: "sessionReplay", blurb: "Records." },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.featureBlurbs).toHaveLength(2);
    expect(summary?.featureBlurbs?.map((b) => b.label)).toEqual([
      "Error Monitoring",
      "Session Replay",
    ]);
  });

  test("stripAnsi strips SGR colour codes from server-supplied blurbs", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: ["errorMonitoring"],
          featureBlurbs: [
            { feature: "errorMonitoring", blurb: "\x1b[31mCaptures.\x1b[0m" },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.featureBlurbs?.[0]?.blurb).toBe("Captures.");
  });

  test("stripAnsi strips CSI sequences with intermediate bytes (e.g. soft reset, cursor style)", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: ["errorMonitoring"],
          featureBlurbs: [
            // \x1b[!p = Soft Terminal Reset (intermediate byte !)
            // \x1b[1 q = Set Cursor Style (intermediate byte space)
            {
              feature: "errorMonitoring",
              blurb: "\x1b[!pCaptures.\x1b[1 q",
            },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.featureBlurbs?.[0]?.blurb).toBe("Captures.");
  });

  test("stripAnsi strips arbitrary OSC sequences (e.g. window title change) from blurbs", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: ["errorMonitoring"],
          featureBlurbs: [
            // \x1b]0;title\x07 = set window title — OSC command, not OSC 8
            {
              feature: "errorMonitoring",
              blurb: "\x1b]0;injected title\x07Captures.",
            },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.featureBlurbs?.[0]?.blurb).toBe("Captures.");
  });

  test("stripAnsi strips single-char C1 ESC sequences (e.g. terminal reset) from blurbs", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: ["errorMonitoring"],
          featureBlurbs: [
            // \x1bc = RIS (Reset to Initial State) — two-char ESC sequence
            { feature: "errorMonitoring", blurb: "\x1bcCaptures." },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.featureBlurbs?.[0]?.blurb).toBe("Captures.");
  });

  test("stripAnsi strips non-SGR CSI sequences (cursor movement, screen-clear) from blurbs", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          features: ["errorMonitoring"],
          featureBlurbs: [
            // \x1b[2J = clear screen, \x1b[1A = cursor up — non-SGR CSI
            {
              feature: "errorMonitoring",
              blurb: "\x1b[2JCaptures.\x1b[1A",
            },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    expect(summary?.featureBlurbs?.[0]?.blurb).toBe("Captures.");
  });

  test("sorts featureBlurbs by canonical display order", () => {
    const { ui, calls } = createMockUI();
    formatResult(
      {
        status: "success",
        result: {
          platform: "Next.js",
          // Server returned performanceMonitoring before errorMonitoring
          features: ["performanceMonitoring", "errorMonitoring"],
          featureBlurbs: [
            { feature: "performanceMonitoring", blurb: "Traces." },
            { feature: "errorMonitoring", blurb: "Captures." },
          ],
        },
      },
      ui
    );

    const summary = summaryCall(calls);
    // errorMonitoring comes before performanceMonitoring in FEATURE_DISPLAY_ORDER
    expect(summary?.featureBlurbs?.map((b) => b.label)).toEqual([
      "Error Monitoring",
      "Tracing",
    ]);
  });
});

describe("formatError", () => {
  test("logs the error message", () => {
    const { ui, calls } = createMockUI();
    formatError({ status: "failed", error: "Connection timed out" }, ui);

    expect(errorMessages(calls)).toContain("Connection timed out");
    const cancel = calls.find((c) => c.kind === "cancel");
    expect(cancel?.kind === "cancel" && cancel.message).toBe("Setup failed");
    expect(feedbackOutcomes(calls)).toEqual(["failed"]);
  });

  test("extracts message from nested result.message", () => {
    const { ui, calls } = createMockUI();
    formatError({ status: "failed", result: { message: "Inner failure" } }, ui);

    expect(errorMessages(calls)).toContain("Inner failure");
  });

  test("falls back to unknown error when no message available", () => {
    const { ui, calls } = createMockUI();
    formatError({ status: "failed" }, ui);

    expect(errorMessages(calls)).toContain(
      "Wizard failed with an unknown error"
    );
  });

  test("shows platform hint for detection failure exit code (20)", () => {
    const { ui, calls } = createMockUI();
    formatError({ status: "failed", result: { exitCode: 20 } }, ui);

    expect(warnMessages(calls).some((m) => m.includes("platform"))).toBe(true);
  });

  test("shows manual install commands for dependency failure (30)", () => {
    const { ui, calls } = createMockUI();
    formatError(
      {
        status: "failed",
        result: {
          exitCode: 30,
          commands: ["npm install @sentry/node"],
        },
      },
      ui
    );

    expect(
      warnMessages(calls).some((m) => m.includes("$ npm install @sentry/node"))
    ).toBe(true);
  });

  test("shows verification hint for exit code 50", () => {
    const { ui, calls } = createMockUI();
    formatError({ status: "failed", result: { exitCode: 50 } }, ui);

    expect(warnMessages(calls).some((m) => m.includes("verification"))).toBe(
      true
    );
  });

  test("shows docs URL when present", () => {
    const { ui, calls } = createMockUI();
    const docsUrl = "https://docs.sentry.io/platforms/react/";
    formatError(
      {
        status: "failed",
        result: { docsUrl },
      },
      ui
    );

    // Pull every URL out of the info messages and check the docs URL
    // is among them. The previous `String.prototype.includes` form
    // tripped CodeQL's "incomplete URL substring sanitization" rule —
    // this regex-based extraction makes the URL-matching intent
    // explicit (and silences the false positive).
    const urlRe = /https?:\/\/[^\s)]+/g;
    const seenUrls = infoMessages(calls).flatMap(
      (msg) => msg.match(urlRe) ?? []
    );
    expect(seenUrls).toContain(docsUrl);
  });
});
