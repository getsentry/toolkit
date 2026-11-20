import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { uiResourceProblems } from "./test-utils/ui-resource-policy";
import tools from "./tools";
import {
  CHART_UI_RESOURCE,
  UI_RESOURCES,
  type UiResource,
} from "./ui-resources";

const catalog = Object.entries(tools).map(([name, tool]) => ({
  name,
  _meta: tool._meta,
}));

const html = "<!doctype html><html></html>";
const view: UiResource = {
  uri: "ui://sentry/test/v1.html",
  name: "test",
  title: "Test",
  description: "Test view",
  htmlSha256: createHash("sha256").update(html).digest("hex"),
  budgetBytes: 1024,
  loadHtml: async () => html,
  meta: { csp: {} },
};
const tool = { name: "test_tool", _meta: { ui: { resourceUri: view.uri } } };

describe("UI resources", () => {
  it("follow every MCP Apps rule in the tool catalog", async () => {
    expect(await uiResourceProblems(catalog, UI_RESOURCES)).toEqual([]);
  });

  it("has a view for render_sentry_chart", () => {
    expect(tools.render_sentry_chart._meta).toEqual({
      ui: { resourceUri: CHART_UI_RESOURCE.uri },
      "openai/outputTemplate": CHART_UI_RESOURCE.uri,
    });
  });
});

describe("uiResourceProblems", () => {
  it("passes a valid view", async () => {
    expect(await uiResourceProblems([tool], [view])).toEqual([]);
  });

  it("fails when a tool names a view that does not exist", async () => {
    const stray = {
      name: "stray",
      _meta: { ui: { resourceUri: "ui://x/v1" } },
    };

    expect(await uiResourceProblems([tool, stray], [view])).toEqual([
      `stray names view "ui://x/v1", which is not a UI resource.`,
    ]);
  });

  it("fails when no tool names a view", async () => {
    expect(await uiResourceProblems([], [view])).toEqual([
      `No tool names ${view.uri}, so it is never listed.`,
    ]);
  });

  it("fails an unversioned URI", async () => {
    const unversioned = { ...view, uri: "ui://sentry/test.html" as const };
    const named = {
      name: "t",
      _meta: { ui: { resourceUri: unversioned.uri } },
    };

    expect(await uiResourceProblems([named], [unversioned])).toEqual([
      expect.stringContaining("has no version"),
    ]);
  });

  it("fails a csp that allows an origin", async () => {
    const leaky = {
      ...view,
      meta: { csp: { connectDomains: ["https://sentry.io"] } },
    };

    expect(await uiResourceProblems([tool], [leaky])).toEqual([
      expect.stringContaining("allows connectDomains in its csp"),
    ]);
  });

  it("fails when the HTML changes but the recorded hash does not", async () => {
    const edited = { ...view, loadHtml: async () => `${html}\n` };

    expect(await uiResourceProblems([tool], [edited])).toEqual([
      expect.stringContaining(`The HTML of ${view.uri} changed`),
    ]);
  });
});
