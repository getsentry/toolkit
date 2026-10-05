/**
 * Tests for clack-utils: cancellation helpers and feature display metadata.
 *
 * These are pure utility functions that don't require module mocking.
 */

import { describe, expect, test } from "vitest";
import {
  abortIfCancelled,
  featureDescription,
  featureLabel,
  PROGRESS_ROTATE_INTERVAL_MS,
  STEP_ACTIVE_LABELS,
  STEP_PROGRESS_MESSAGES,
  sortFeatures,
  WizardCancelledError,
} from "../../../src/lib/init/clack-utils.js";

describe("WizardCancelledError", () => {
  test("has correct message", () => {
    const err = new WizardCancelledError();
    expect(err.message).toBe("Setup cancelled.");
  });

  test("has correct name", () => {
    const err = new WizardCancelledError();
    expect(err.name).toBe("WizardCancelledError");
  });

  test("is an instance of Error", () => {
    const err = new WizardCancelledError();
    expect(err).toBeInstanceOf(Error);
  });
});

describe("abortIfCancelled", () => {
  test("passes through non-cancel values", () => {
    expect(abortIfCancelled("hello")).toBe("hello");
    expect(abortIfCancelled(42)).toBe(42);
    expect(abortIfCancelled(null)).toBeNull();
  });

  test("passes through object values", () => {
    const obj = { key: "value" };
    expect(abortIfCancelled(obj)).toBe(obj);
  });
});

describe("featureLabel", () => {
  test("returns label for known feature", () => {
    expect(featureLabel("errorMonitoring")).toBe("Error Monitoring");
    expect(featureLabel("performanceMonitoring")).toBe("Tracing");
    expect(featureLabel("logs")).toBe("Logs");
    expect(featureLabel("crons")).toBe("Crons & Uptime Monitors");
    expect(featureLabel("attachments")).toBe("Attachments");
    expect(featureLabel("aiMonitoring")).toBe("Agent Tracing");
    expect(featureLabel("mcpObservability")).toBe("MCP Observability");
    expect(featureLabel("userFeedback")).toBe("User Feedback");
  });

  test("returns id as passthrough for unknown feature", () => {
    expect(featureLabel("unknownFeature")).toBe("unknownFeature");
  });
});

describe("featureDescription", () => {
  test("returns description for known feature", () => {
    expect(featureDescription("errorMonitoring")).toBe(
      "Automatically capture exceptions and stack traces"
    );
    expect(featureDescription("performanceMonitoring")).toBe(
      "Find bottlenecks, broken requests, and understand application flow end-to-end"
    );
    expect(featureDescription("sessionReplay")).toBe(
      "Watch real user sessions to see what went wrong"
    );
    expect(featureDescription("profiling")).toBe(
      "Pinpoint the functions and lines of code responsible for performance issues"
    );
    expect(featureDescription("logs")).toBe(
      "See logs in context with errors and performance issues"
    );
    expect(featureDescription("metrics")).toBe(
      "Track application performance and usage over time with custom metrics"
    );
    expect(featureDescription("sourceMaps")).toBe(
      "Turn minified production stack traces back into your original source code"
    );
    expect(featureDescription("crons")).toBe(
      "Detect failed, missed, or delayed scheduled jobs"
    );
    expect(featureDescription("attachments")).toBe(
      "Link user-supplied data to captured events"
    );
    expect(featureDescription("aiMonitoring")).toBe(
      "Understand AI calls, latency, token usage, cost, and failures"
    );
    expect(featureDescription("mcpObservability")).toBe(
      "Trace MCP tool calls and understand failures across agent workflows"
    );
    expect(featureDescription("userFeedback")).toBe(
      "Collect user reports with the error and session context needed to investigate"
    );
    expect(featureDescription("reactFeatures")).toBe(
      "Capture React-specific errors with component and rendering context"
    );
  });

  test("returns undefined for unknown feature", () => {
    expect(featureDescription("unknownFeature")).toBeUndefined();
  });
});

describe("sortFeatures", () => {
  test("orders known features by canonical display order", () => {
    expect(
      sortFeatures([
        "userFeedback",
        "logs",
        "errorMonitoring",
        "sourceMaps",
        "crons",
        "attachments",
        "aiMonitoring",
        "mcpObservability",
      ])
    ).toEqual([
      "errorMonitoring",
      "logs",
      "aiMonitoring",
      "attachments",
      "crons",
      "mcpObservability",
      "sourceMaps",
      "userFeedback",
    ]);
  });

  test("keeps unknown features after known ones", () => {
    expect(sortFeatures(["unknown", "metrics", "another"])).toEqual([
      "metrics",
      "unknown",
      "another",
    ]);
  });
});

describe("STEP_PROGRESS_MESSAGES", () => {
  test("plan-codemods has multiple rotating messages", () => {
    const messages = STEP_PROGRESS_MESSAGES["plan-codemods"];
    expect(messages).toBeDefined();
    expect(messages!.length).toBeGreaterThanOrEqual(3);
    for (const msg of messages!) {
      expect(msg).toMatch(/\.\.\.$/);
    }
  });

  test("detect-platform has multiple rotating messages", () => {
    const messages = STEP_PROGRESS_MESSAGES["detect-platform"];
    expect(messages).toBeDefined();
    expect(messages!.length).toBeGreaterThanOrEqual(2);
  });

  test("every step with progress messages also has an active label", () => {
    for (const stepId of Object.keys(STEP_PROGRESS_MESSAGES)) {
      expect(STEP_ACTIVE_LABELS[stepId]).toBeDefined();
    }
  });

  test("rotation interval is a positive number", () => {
    expect(PROGRESS_ROTATE_INTERVAL_MS).toBeGreaterThan(0);
  });
});
