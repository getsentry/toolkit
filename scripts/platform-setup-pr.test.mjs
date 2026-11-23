import assert from "node:assert/strict";
import test from "node:test";
import { planRegeneration } from "./platform-setup-pr.mjs";

test("does nothing when the default branch already has the data", () => {
  assert.equal(
    planRegeneration({ generated: "a", base: "a", branch: undefined }),
    "none",
  );
  assert.equal(
    planRegeneration({ generated: "a", base: "a", branch: "b" }),
    "none",
  );
});

test("opens a PR for new data when none is open", () => {
  assert.equal(
    planRegeneration({ generated: "b", base: "a", branch: undefined }),
    "open",
  );
});

test("leaves the open PR alone when it already has the data", () => {
  assert.equal(
    planRegeneration({ generated: "b", base: "a", branch: "b" }),
    "none",
  );
});

test("updates the open PR when the data changed again", () => {
  assert.equal(
    planRegeneration({ generated: "c", base: "a", branch: "b" }),
    "update",
  );
});
