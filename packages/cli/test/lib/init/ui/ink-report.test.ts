import { describe, expect, test } from "vitest";
import { stripAnsi } from "../../../../src/lib/formatters/plain-detect.js";
import {
  formatFailureReport,
  formatSuccessExitLine,
  formatSuccessReport,
} from "../../../../src/lib/init/ui/ink-report.js";

describe("formatSuccessReport with summary fields", () => {
  test("renders each field label and value", () => {
    const output = stripAnsi(
      formatSuccessReport("Done!", {
        fields: [
          { label: "Project", value: "my-app" },
          { label: "Org", value: "acme" },
        ],
      })
    );
    expect(output).toContain("Project");
    expect(output).toContain("my-app");
    expect(output).toContain("Org");
    expect(output).toContain("acme");
  });

  test("labels are right-padded to the same width", () => {
    const output = stripAnsi(
      formatSuccessReport("Done!", {
        fields: [
          { label: "Short", value: "x" },
          { label: "LongerLabel", value: "y" },
        ],
      })
    );
    const lines = output
      .split("\n")
      .filter((l) => l.includes("  x") || l.includes("  y"));
    // Both lines should start with the same indentation + label block
    const shortLine = lines.find((l) => l.includes("x"));
    const longLine = lines.find((l) => l.includes("y"));
    // The value "x" should be padded so the value column aligns with "y"
    expect(shortLine?.indexOf("x")).toBe(longLine?.indexOf("y"));
  });

  test("empty fields list produces no extra blank section", () => {
    const plain = stripAnsi(formatSuccessReport("Done!", { fields: [] }));
    // Only the success icon + message; no indented field block
    const nonEmpty = plain.split("\n").filter(Boolean);
    expect(nonEmpty.length).toBe(1);
    expect(nonEmpty[0]).toContain("Done!");
  });
});

describe("formatSuccessReport with featureBlurbs", () => {
  test("renders Here's what we set up heading and blurb content", () => {
    const output = stripAnsi(
      formatSuccessReport("Done!", {
        fields: [],
        featureBlurbs: [
          { label: "Error Monitoring", blurb: "Captures exceptions." },
          { label: "Tracing", blurb: "Traces requests end-to-end." },
        ],
      })
    );
    expect(output).toContain("Here's what we set up");
    expect(output).toContain("Error Monitoring");
    expect(output).toContain("Captures exceptions.");
    expect(output).toContain("Tracing");
    expect(output).toContain("Traces requests end-to-end.");
  });

  test("no blurbs section when featureBlurbs is absent", () => {
    const output = stripAnsi(formatSuccessReport("Done!", { fields: [] }));
    expect(output).not.toContain("Here's what we set up");
  });

  test("no blurbs section when featureBlurbs is empty", () => {
    const output = stripAnsi(
      formatSuccessReport("Done!", { fields: [], featureBlurbs: [] })
    );
    expect(output).not.toContain("Here's what we set up");
  });
});

describe("formatSuccessReport with changedFiles", () => {
  test("shows Changed files heading and file paths", () => {
    const output = stripAnsi(
      formatSuccessReport("Done!", {
        fields: [],
        changedFiles: [
          { path: "src/index.ts", action: "modify" },
          { path: "sentry.config.ts", action: "create" },
        ],
      })
    );
    expect(output).toContain("Changed files");
    expect(output).toContain("index.ts");
    expect(output).toContain("sentry.config.ts");
  });

  test("no Changed files heading when list is empty", () => {
    const output = stripAnsi(
      formatSuccessReport("Done!", { fields: [], changedFiles: [] })
    );
    expect(output).not.toContain("Changed files");
  });

  test("no Changed files heading when changedFiles is absent", () => {
    const output = stripAnsi(formatSuccessReport("Done!", { fields: [] }));
    expect(output).not.toContain("Changed files");
  });
});

describe("formatFailureReport with error log entries", () => {
  test("error entries appear in output", () => {
    const output = stripAnsi(
      formatFailureReport("Setup failed", [
        { severity: "error", text: "Could not reach Sentry" },
        { severity: "error", text: "Auth token missing" },
      ])
    );
    expect(output).toContain("Could not reach Sentry");
    expect(output).toContain("Auth token missing");
  });

  test("only the last 5 error entries are shown", () => {
    const logs = Array.from({ length: 8 }, (_, i) => ({
      severity: "error" as const,
      text: `Error ${String(i + 1)}`,
    }));
    const output = stripAnsi(formatFailureReport("Setup failed", logs));
    expect(output).not.toContain("Error 1");
    expect(output).not.toContain("Error 2");
    expect(output).not.toContain("Error 3");
    expect(output).toContain("Error 4");
    expect(output).toContain("Error 8");
  });

  test("entry whose text equals the top-level message is excluded", () => {
    const output = stripAnsi(
      formatFailureReport("Setup failed", [
        { severity: "error", text: "Setup failed" },
        { severity: "error", text: "Underlying cause" },
      ])
    );
    const lines = output.split("\n");
    // "Setup failed" appears once (the heading), not a second time as a log entry
    const matches = lines.filter((l) => l.includes("Setup failed"));
    expect(matches.length).toBe(1);
    expect(output).toContain("Underlying cause");
  });

  test("colon-separated entry splits label from detail onto separate lines", () => {
    const output = stripAnsi(
      formatFailureReport("Setup failed", [
        { severity: "error", text: "Network error: connection refused" },
      ])
    );
    const lines = output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const labelLine = lines.find((l) => l === "Network error");
    const detailLine = lines.find((l) => l === "connection refused");
    expect(labelLine).toBeDefined();
    expect(detailLine).toBeDefined();
  });

  test("non-error log entries are not included", () => {
    const output = stripAnsi(
      formatFailureReport("Setup failed", [
        { severity: "info", text: "Info message" },
        { severity: "warn", text: "Warn message" },
        { severity: "error", text: "Real error" },
      ])
    );
    expect(output).not.toContain("Info message");
    expect(output).not.toContain("Warn message");
    expect(output).toContain("Real error");
  });
});

describe("Ink post-dispose feedback reports", () => {
  test("success report includes the success feedback command", () => {
    const output = stripAnsi(
      formatSuccessReport(
        "Sentry SDK installed successfully!",
        undefined,
        [
          "Nice, setup made it through.",
          "Tell us what felt great or rough:",
          '$ sentry cli feedback "sentry init worked well"',
        ].join("\n")
      )
    );

    expect(output).toContain("Sentry SDK installed successfully!");
    expect(output).toContain(
      [
        "Nice, setup made it through.",
        "   Tell us what felt great or rough:",
        '   $ sentry cli feedback "sentry init worked well"',
        "",
      ].join("\n")
    );
    expect(output.endsWith("\n")).toBe(true);
  });

  test("failure report includes the failed feedback command", () => {
    const output = stripAnsi(
      formatFailureReport(
        "Setup failed",
        [],
        [
          "Setup hit a wall.",
          "Tell us what happened so we can fix it:",
          '$ sentry cli feedback "sentry init failed"',
        ].join("\n")
      )
    );

    expect(output).toContain("Setup failed");
    expect(output).toContain(
      [
        "Setup hit a wall.",
        "   Tell us what happened so we can fix it:",
        '   $ sentry cli feedback "sentry init failed"',
        "",
      ].join("\n")
    );
    expect(output.endsWith("\n")).toBe(true);
  });

  test("cancel report includes the cancelled feedback command", () => {
    const output = stripAnsi(
      formatFailureReport(
        "Setup cancelled.",
        [],
        [
          "Sad to see setup stop. Was something going sideways?",
          "Tell us so we can fix it:",
          '$ sentry cli feedback "sentry init was cancelled"',
        ].join("\n")
      )
    );

    expect(output).toContain("Setup cancelled.");
    expect(output).toContain(
      [
        "Sad to see setup stop. Was something going sideways?",
        "   Tell us so we can fix it:",
        '   $ sentry cli feedback "sentry init was cancelled"',
        "",
      ].join("\n")
    );
    expect(output.endsWith("\n")).toBe(true);
  });
});

describe("formatSuccessExitLine", () => {
  const baseCompletion = {
    projectName: "my-app",
    features: [],
    featureBlurbs: [],
    changedFileCount: 3,
    issuesUrl: "https://acme.sentry.io/issues/",
    agentInstallCommand: "npx @sentry/ai install",
  };

  test("is a compact confirmation — no changed-files or feature dump", () => {
    const output = stripAnsi(
      formatSuccessExitLine({
        fields: [{ label: "Platform", value: "next.js" }],
        changedFiles: [{ action: "create", path: "instrument.ts" }],
        featureBlurbs: [{ label: "Errors", blurb: "Captures exceptions." }],
        completion: { ...baseCompletion, verification: { received: false } },
      })
    );
    expect(output).toContain("Sentry is watching my-app");
    expect(output).toContain("See your first error");
    expect(output).toContain("https://acme.sentry.io/issues/");
    // The full summary stays on the interactive screen, not the exit echo.
    expect(output).not.toContain("Here's what we set up");
    expect(output).not.toContain("Changed files");
    expect(output).not.toContain("instrument.ts");
    // No feedback prompt chained onto the success exit.
    expect(output).not.toContain("sentry cli feedback");
  });

  test("celebrates and deep-links the event when verified", () => {
    const output = stripAnsi(
      formatSuccessExitLine({
        fields: [],
        completion: {
          ...baseCompletion,
          verification: {
            received: true,
            eventUrl: "https://acme.sentry.io/issues/?query=event.id:abc",
          },
        },
      })
    );
    expect(output).toContain("View your first event");
    expect(output).toContain("event.id:abc");
  });
});
