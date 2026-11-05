import { describe, expect, test } from "vitest";
import {
  buildAlertCreateBody,
  buildAlertUpdateBody,
} from "../../../src/commands/alert/mutation-utils.js";
import { workflow } from "../../fixtures/workflow.js";

describe("native alert request construction", () => {
  test("supports native trigger groups and complete action-filter groups without flattening", () => {
    const triggers = {
      logicType: "any",
      conditions: [{ type: "eq", comparison: 75, conditionResult: true }],
    };
    const actionFilters = [
      {
        logicType: "none",
        conditions: [{ type: "eq", comparison: 50, conditionResult: true }],
        actions: [
          {
            type: "email",
            data: {},
            config: { targetType: "user", targetIdentifier: "123" },
          },
        ],
      },
    ];
    const body = buildAlertCreateBody({
      name: "Metric alert",
      monitor: ["9,10"],
      trigger: [JSON.stringify(triggers)],
      "action-filter": [JSON.stringify(actionFilters)],
      config: '{"frequency":0}',
      "dry-run": false,
    });
    expect(body).toEqual({
      name: "Metric alert",
      enabled: true,
      detectorIds: [9, 10],
      config: { frequency: 0 },
      triggers,
      actionFilters,
    });
  });

  test("a full config edit is explicit replacement, whereas frequency preserves existing config", () => {
    const current = workflow({
      config: { frequency: 30, futureSetting: "keep" },
    });
    expect(
      buildAlertUpdateBody({ frequency: 0, "dry-run": false }, current),
    ).toEqual({
      name: current.name,
      enabled: false,
      config: { frequency: 0, futureSetting: "keep" },
    });
    expect(
      buildAlertUpdateBody(
        { config: '{"frequency":60}', "dry-run": false },
        current,
      ),
    ).toEqual({
      name: current.name,
      enabled: false,
      config: { frequency: 60 },
    });
  });

  test("trigger edits preserve the current group ID and native metadata", () => {
    const current = workflow();
    expect(
      buildAlertUpdateBody(
        { trigger: ["regression"], "dry-run": false },
        current,
      ),
    ).toEqual({
      name: current.name,
      enabled: false,
      triggers: {
        ...current.triggers,
        logicType: "any-short",
        conditions: [
          { type: "regression_event", comparison: true, conditionResult: true },
        ],
      },
    });
    expect(current.triggers?.conditions).toEqual([
      {
        id: "101",
        type: "first_seen_event",
        comparison: true,
        conditionResult: true,
      },
    ]);
  });

  test("shortcut action edits preserve conditions and every other group", () => {
    const current = workflow();
    const action = {
      type: "email",
      data: {},
      config: { targetType: "team", targetIdentifier: "7" },
    };
    const body = buildAlertUpdateBody(
      { action: [JSON.stringify(action)], "dry-run": false },
      current,
    );
    expect(body.actionFilters).toEqual([
      { ...current.actionFilters?.[0], actions: [action] },
      current.actionFilters?.[1],
    ]);
    expect(current.actionFilters?.[0]?.actions).toEqual(
      workflow().actionFilters?.[0]?.actions,
    );
  });

  test("explicitly clears links, environment and owner using native fields", () => {
    expect(
      buildAlertUpdateBody(
        {
          monitor: [""],
          environment: "",
          owner: "",
          enabled: true,
          "dry-run": false,
        },
        workflow(),
      ),
    ).toEqual({
      name: "Notify on-call",
      enabled: true,
      detectorIds: [],
      environment: null,
      owner: null,
    });
  });

  test("rejects conflicting full groups and shortcut group edits", () => {
    expect(() =>
      buildAlertCreateBody({
        name: "Conflicting",
        "action-filter": ["[]"],
        action: ["[]"],
        "dry-run": false,
      }),
    ).toThrow("not both");
  });

  test("accepts zero frequency, but rejects negative/fractional values and invalid monitor IDs", () => {
    expect(
      buildAlertCreateBody({
        name: "Immediate",
        frequency: 0,
        "dry-run": false,
      }).config,
    ).toEqual({ frequency: 0 });
    expect(() =>
      buildAlertCreateBody({
        name: "Invalid",
        frequency: -1,
        "dry-run": false,
      }),
    ).toThrow("nonnegative integer");
    expect(() =>
      buildAlertCreateBody({
        name: "Invalid",
        frequency: 1.5,
        "dry-run": false,
      }),
    ).toThrow("nonnegative integer");
    expect(() =>
      buildAlertCreateBody({
        name: "Invalid",
        monitor: ["foo"],
        "dry-run": false,
      }),
    ).toThrow("positive integer IDs");
  });

  test("requires a name on create and a field change on edit", () => {
    expect(() => buildAlertCreateBody({ "dry-run": false })).toThrow(
      "name is required",
    );
    expect(() => buildAlertUpdateBody({ "dry-run": true }, workflow())).toThrow(
      "at least one field",
    );
  });
});
