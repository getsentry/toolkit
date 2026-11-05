import { describe, expect, test } from "vitest";
import { formatAlertView } from "../../../src/lib/formatters/alerts.js";
import { workflow } from "../../fixtures/workflow.js";

describe("native alert formatting", () => {
  test("view shows actual nested triggers, action filters, actions and monitor links", () => {
    const output = formatAlertView({ ...workflow(), org: "test-org" });
    for (const value of [
      "Enabled: false",
      "Monitors: 9",
      '"frequency": 30',
      "first_seen_event",
      '"id": "200"',
      '"id": "300"',
      "slack",
      "C123",
      "#on-call",
      "email",
      '"targetIdentifier": "7"',
    ]) {
      expect(output).toContain(value);
    }
    expect(output).not.toContain("Action Match:");
  });
});
