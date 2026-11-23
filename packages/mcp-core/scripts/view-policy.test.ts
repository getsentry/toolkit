import { describe, expect, it } from "vitest";
import { CHART_APP_HTML } from "../src/ui/chart-app.generated.ts";
import { CHART_UI_RESOURCE } from "../src/ui-resources.ts";
import { viewHtmlProblems } from "./view-policy.ts";

const page = (body: string) =>
  `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("viewHtmlProblems", () => {
  it("passes the generated chart view", () => {
    expect(
      viewHtmlProblems("chart", CHART_APP_HTML, CHART_UI_RESOURCE.budgetBytes),
    ).toEqual([]);
  });

  it("fails a view over its budget", () => {
    expect(viewHtmlProblems("big", page("x".repeat(2048)), 1024)).toEqual([
      expect.stringContaining("over its 1024-byte budget"),
    ]);
  });

  it.each([
    ['<script src="https://cdn.example.com/a.js"></script>', "src or href"],
    ['<img src="//cdn.example.com/a.png">', "src or href"],
    ['<link rel="stylesheet" href="styles.css">', "<link>"],
    ["<style>@import 'https://fonts.example.com/a.css';</style>", "@import"],
    ["<style>body{background:url(https://example.com/a.png)}</style>", "url()"],
    ["<script>fetch('/api')</script>", "fetch()"],
    ["<script>new XMLHttpRequest()</script>", "XMLHttpRequest"],
    ["<script>new WebSocket('wss://example.com')</script>", "WebSocket"],
    ["<script>new EventSource('/events')</script>", "EventSource"],
    ["<script>navigator.sendBeacon('/b')</script>", "sendBeacon"],
    ["<script>import('./chunk.js')</script>", "dynamic import()"],
  ])("fails a view that loads from the network: %s", (body, label) => {
    expect(viewHtmlProblems("leaky", page(body), 1024)).toEqual([
      expect.stringContaining(label),
    ]);
  });

  it("allows inline data and the SVG namespace", () => {
    const body =
      '<svg xmlns="http://www.w3.org/2000/svg"></svg><img src="data:image/png;base64,AA==">';
    expect(viewHtmlProblems("inline", page(body), 1024)).toEqual([]);
  });
});
