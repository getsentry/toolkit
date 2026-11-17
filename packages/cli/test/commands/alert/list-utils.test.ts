import { describe, expect, test } from "vitest";
import { throwAlertListFetchFailure } from "../../../src/commands/alert/list-utils.js";
import { TimeoutError } from "../../../src/lib/errors.js";

describe("throwAlertListFetchFailure", () => {
  test("keeps a timeout a TimeoutError, with its hint", () => {
    const timeout = new TimeoutError(
      "Request timed out after 30s.",
      "Try again.",
    );
    let thrown: unknown;
    try {
      throwAlertListFetchFailure("Failed to list alert rules", timeout);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TimeoutError);
    expect((thrown as TimeoutError).message).toBe(
      "Failed to list alert rules: Request timed out after 30s.",
    );
    expect((thrown as TimeoutError).hint).toBe("Try again.");
  });
});
