import { describe, expect, test } from "vitest";
import { getConnectionPresentation } from "./presentation.ts";

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
});
