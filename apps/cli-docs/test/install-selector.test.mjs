import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const component = readFileSync(fileURLToPath(new URL("../src/components/InstallSelector.astro", import.meta.url)), "utf8");
const script = component.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "InstallSelector must include its inline script");

function createSelector() {
  const listeners = new Map();
  const classes = new Set();
  const installBox = {
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
    },
    querySelector: () => null,
  };
  const trigger = {
    addEventListener: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    setAttribute: () => {},
    focus: () => {},
    click: () => {
      for (const listener of listeners.get("click") ?? []) listener({ stopPropagation() {} });
    },
  };
  const selector = {
    dataset: {},
    querySelector: (name) => ({ ".install-box": installBox, ".dropdown-trigger": trigger })[name] ?? null,
    querySelectorAll: () => [],
  };
  return { selector, trigger, installBox };
}

test("the selector opens on one click after scripts rerun and on a new page", () => {
  const first = createSelector();
  const selectors = [first.selector];
  const listeners = new Map();
  const document = {
    readyState: "complete",
    querySelectorAll: (name) => name === ".install-selector" ? selectors : [],
    addEventListener: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  };
  const context = { document, window: {}, navigator: {}, setTimeout };
  runInNewContext(script, context);
  runInNewContext(script, context);
  for (const listener of listeners.get("astro:after-swap") ?? []) listener();

  first.trigger.click();
  assert.equal(first.installBox.classList.contains("open"), true);
  first.trigger.click();
  assert.equal(first.installBox.classList.contains("open"), false);
  assert.equal(listeners.get("click")?.length, 1);

  const second = createSelector();
  selectors.splice(0, 1, second.selector);
  for (const listener of listeners.get("astro:after-swap") ?? []) listener();
  second.trigger.click();
  assert.equal(second.installBox.classList.contains("open"), true);
});
