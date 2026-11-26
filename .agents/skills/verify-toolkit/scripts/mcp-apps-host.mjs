#!/usr/bin/env node
// Act as an MCP Apps host for render_sentry_chart and render_issue_chart, with
// no LLM: start the mock stdio server, call the tools, read their shared
// `ui://` view, and mount the view in a headless browser through the ext-apps
// AppBridge, the way Claude or VS Code does. Screenshots the chart in light and
// dark, after the range picker calls the tool again through the host, in
// fullscreen, split by an attribute, and for one issue. The grouped
// chart is p95 by release over 7 days at 1h, where the mock has busy releases
// and sparse ones whose p95 is higher, as in getsentry/toolkit#2451. Writes
// evidence and one PASS or FAIL line per check to checks.txt in --out. See
// ../SKILL.md.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { offlineEnv } from "./offline-env.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("--out") + 1];
if (!argv.includes("--out") || !out) {
  console.error("usage: mcp-apps-host.mjs --out DIR");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

// The MCP client SDK is a dependency of the test client; esbuild, the
// AppBridge, and playwright-core are dev dependencies of mcp-core.
const fromClient = createRequire(
  join(repo, "packages/mcp-test-client/package.json"),
);
const fromCore = createRequire(join(repo, "packages/mcp-core/package.json"));
const load = (require, id) => import(pathToFileURL(require.resolve(id)).href);
const { Client } = await load(
  fromClient,
  "@modelcontextprotocol/sdk/client/index.js",
);
const { StdioClientTransport } = await load(
  fromClient,
  "@modelcontextprotocol/sdk/client/stdio.js",
);
const { build } = await load(fromCore, "esbuild");
const { chromium } = fromCore("playwright-core");

const TOOL = "render_sentry_chart";
const ORG = "sentry-mcp-evals";
const ERRORS_CHART = {
  organizationSlug: ORG,
  dataset: "errors",
  query: "level:error",
  yAxis: "count()",
  period: "24h",
};
const ISSUE_TOOL = "render_issue_chart";
// A performance issue: its events live in the issue platform, and the errors
// dataset would chart it as all zeros.
const ISSUE_CHART = { organizationSlug: ORG, issueId: "PERF-N1-001" };
const GROUPED_CHART = {
  organizationSlug: ORG,
  dataset: "spans",
  query: "is_transaction:true",
  yAxis: "p95(span.duration)",
  groupBy: "release",
  period: "7d",
  interval: "1h",
};
// Largest structured result for GROUPED_CHART: 5 series of 168 buckets. The
// compact result is about 12 KB; one object per bucket was about 200 KB.
const GROUPED_BUDGET_BYTES = 16 * 1024;
// The spec's default view CSP: no network, no eval.
const DEFAULT_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'";

const write = (name, value) =>
  writeFileSync(
    join(out, name),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
let failures = 0;
function check(id, ok, detail) {
  const line = `${ok ? "PASS" : "FAIL"} mcp-apps#${id}: ${detail}`;
  if (!ok) failures++;
  console.log(line);
  appendFileSync(join(out, "checks.txt"), `${line}\n`);
}

// A minimal host page: mounts the view in a sandboxed iframe under the
// default CSP and bridges it with AppBridge. Tool calls from the view go to
// Node (window.mcpCallTool), which forwards them to the real server.
const hostScript = (
  await build({
    stdin: {
      resolveDir: join(repo, "packages/mcp-core"),
      contents: `
        import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
        window.hostLog = [];
        // A capable host advertises ui/update-model-context and fullscreen;
        // the other advertises neither, so the view must not use them.
        window.mountView = async ({ html, theme, toolArgs, toolResult, capable = true }) => {
          document.body.dataset.theme = theme;
          const iframe = document.createElement("iframe");
          iframe.setAttribute("sandbox", "allow-scripts");
          document.getElementById("host").replaceChildren(iframe);
          const bridge = new AppBridge(
            null,
            { name: "verify-toolkit host", version: "0.0.0" },
            capable
              ? { openLinks: {}, serverTools: {}, updateModelContext: { text: {}, structuredContent: {} } }
              : { openLinks: {}, serverTools: {} },
            { hostContext: { theme, locale: "en-US", timeZone: "UTC", platform: "web", displayMode: "inline", ...(capable ? { availableDisplayModes: ["inline", "fullscreen"] } : {}), containerDimensions: { width: 720, maxHeight: 900 } } },
          );
          let displayMode = "inline";
          bridge.oncalltool = async (params) => {
            window.hostLog.push({ method: "tools/call", params });
            return await window.mcpCallTool(params);
          };
          bridge.onopenlink = async (params) => {
            window.hostLog.push({ method: "ui/open-link", params });
            return {};
          };
          bridge.onupdatemodelcontext = async (params) => {
            window.hostLog.push({ method: "ui/update-model-context", params });
            return {};
          };
          bridge.onrequestdisplaymode = async (params) => {
            window.hostLog.push({ method: "ui/request-display-mode", params });
            displayMode = params.mode === "fullscreen" ? "fullscreen" : "inline";
            // Fullscreen: the host sizes the view, here 720x560.
            if (displayMode === "fullscreen") iframe.style.height = "560px";
            return { mode: displayMode };
          };
          bridge.onsizechange = ({ height }) => {
            if (height && displayMode === "inline") iframe.style.height = height + "px";
          };
          window.bridge = bridge;
          const initialized = new Promise((done) => { bridge.oninitialized = done; });
          await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
          iframe.srcdoc = html.replace("<head>", ${JSON.stringify(`<head><meta http-equiv="Content-Security-Policy" content="${DEFAULT_CSP}">`)});
          await initialized;
          await bridge.sendToolInput({ arguments: toolArgs });
          await bridge.sendToolResult(toolResult);
        };
      `,
    },
    bundle: true,
    format: "iife",
    write: false,
  })
).outputFiles[0].text;
const hostPage = `<!doctype html><html><head><style>
  body { margin: 0; padding: 24px; background: #f4f2f7; font-family: sans-serif; }
  body[data-theme="dark"] { background: #121016; }
  iframe { display: block; width: 720px; height: 320px; border: 1px solid #8884; border-radius: 10px; }
</style></head><body><div id="host"></div><script>${hostScript}</script></body></html>`;

const { env, cleanup } = offlineEnv({ token: true });
delete env.SENTRY_HOST;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--experimental-strip-types",
    "--import",
    join(repo, "scripts/strip-types-resolve.mjs"),
    join(repo, "packages/mcp-server-evals/src/bin/start-mock-stdio.ts"),
  ],
  env,
  cwd: repo,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk;
});
const client = new Client({
  name: "verify-toolkit-apps-host",
  version: "0.0.0",
});
let browser;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === TOOL);
  write("tool.json", tool ?? null);
  const uri = tool?._meta?.ui?.resourceUri;
  check(
    "tool-meta",
    typeof uri === "string" &&
      uri.startsWith("ui://") &&
      tool._meta["openai/outputTemplate"] === uri &&
      !("ui/resourceUri" in tool._meta),
    `${TOOL} _meta.ui.resourceUri=${uri}, openai/outputTemplate=${tool?._meta?.["openai/outputTemplate"]}`,
  );

  const { resources } = await client.listResources();
  const { contents } = await client.readResource({ uri });
  const view = contents[0];
  write("resources-list.json", resources);
  write("resource-read.json", {
    ...view,
    text: `<${view?.text?.length ?? 0} chars, see view.html>`,
  });
  write("view.html", view?.text ?? "");
  check(
    "view-resource",
    resources.some((r) => r.uri === uri) &&
      view?.mimeType === "text/html;profile=mcp-app" &&
      view.text.startsWith("<!doctype html>"),
    `resources/read ${uri}: ${view?.mimeType}, ${Math.round((view?.text?.length ?? 0) / 1024)} KiB HTML`,
  );

  const calls = [];
  const callTool = async (params) => {
    const result = await client.callTool(params);
    calls.push({ request: params, result });
    return result;
  };
  const errorsResult = await callTool({ name: TOOL, arguments: ERRORS_CHART });
  const groupedResult = await callTool({
    name: TOOL,
    arguments: GROUPED_CHART,
  });
  const issueTool = tools.find((t) => t.name === ISSUE_TOOL);
  const issueResult = await callTool({
    name: ISSUE_TOOL,
    arguments: ISSUE_CHART,
  });

  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 768, height: 520 },
    deviceScaleFactor: 2,
  });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  await page.exposeFunction("mcpCallTool", callTool);
  await page.setContent(hostPage);
  const frame = page.frameLocator("iframe");
  const mount = async (theme, toolArgs, toolResult, capable = true) => {
    await page.evaluate((input) => window.mountView(input), {
      html: view.text,
      theme,
      toolArgs,
      toolResult,
      capable,
    });
    await frame.locator("svg path").first().waitFor();
    // Let the view report its size and the host resize the iframe.
    await page.waitForTimeout(300);
  };
  const shot = async (name) => {
    await page.locator("#host").screenshot({ path: join(out, name) });
    return join(out, name);
  };

  await mount("light", ERRORS_CHART, errorsResult);
  const svgBox = await frame.locator("svg").boundingBox();
  await page.mouse.move(
    svgBox.x + svgBox.width * 0.7,
    svgBox.y + svgBox.height / 2,
  );
  const tooltip = await frame.locator(".tooltip").innerText();
  const light = await shot("chart-light.png");
  const lightBg = await frame
    .locator("body")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const emptyHidden = await frame.locator(".state").isHidden();
  check(
    "view-renders",
    tooltip.includes("count()") && emptyHidden,
    `light chart with hover tooltip "${tooltip.replace(/\s+/g, " ")}" -> ${light}`,
  );

  await mount("dark", ERRORS_CHART, errorsResult);
  const darkBg = await frame
    .locator("body")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const dark = await shot("chart-dark.png");
  check(
    "view-theme",
    lightBg !== darkBg,
    `host theme light=${lightBg} dark=${darkBg} -> ${dark}`,
  );

  await mount("light", ERRORS_CHART, errorsResult);
  const before = await frame.locator(".subtitle").innerText();
  await frame.getByRole("button", { name: "7d", exact: true }).click();
  await frame.locator(".subtitle", { hasText: "Last 7 days" }).waitFor();
  await frame.locator('.chart[data-loading="false"]').waitFor();
  const range = await shot("chart-range-7d.png");
  const hostLog = await page.evaluate(() => window.hostLog);
  const rangeCall = hostLog.find((entry) => entry.method === "tools/call");
  const rangeResult = calls.at(-1);
  check(
    "range-roundtrip",
    rangeCall?.params?.name === TOOL &&
      rangeCall.params.arguments.period === "7d" &&
      rangeResult?.result?.structuredContent?.timeRange?.statsPeriod === "7d",
    `"${before}" -> view called ${TOOL} period=7d through the host, got ${rangeResult?.result?.structuredContent?.times?.length} buckets -> ${range}`,
  );

  const modelUpdate = hostLog.find(
    (entry) => entry.method === "ui/update-model-context",
  );
  const modelText = modelUpdate?.params?.content?.[0]?.text ?? "";
  const modelChart = modelUpdate?.params?.structuredContent?.chart;
  check(
    "model-context",
    modelText.includes("Last 7 days") &&
      modelUpdate.params.structuredContent.arguments?.period === "7d" &&
      modelChart?.timeRange?.statsPeriod === "7d" &&
      modelChart.times.length ===
        rangeResult?.result?.structuredContent?.times?.length,
    `after the range change the view sent ui/update-model-context: "${modelText.split("\n")[0]}", structuredContent.chart has ${modelChart?.times?.length} buckets`,
  );

  const fullscreenButton = frame.getByRole("button", {
    name: "Fullscreen",
    exact: true,
  });
  const inlineHeight = (await frame.locator("svg").boundingBox()).height;
  await fullscreenButton.click();
  await frame
    .locator("html[data-display-mode='fullscreen']")
    .waitFor({ state: "attached" });
  await page.waitForTimeout(300);
  const fullHeight = (await frame.locator("svg").boundingBox()).height;
  const fullscreen = await shot("chart-fullscreen.png");
  await frame.getByRole("button", { name: "Exit fullscreen" }).click();
  await frame
    .locator("html[data-display-mode='inline']")
    .waitFor({ state: "attached" });
  await page.waitForTimeout(300);
  const backHeight = (await frame.locator("svg").boundingBox()).height;
  const modeRequests = (await page.evaluate(() => window.hostLog))
    .filter((entry) => entry.method === "ui/request-display-mode")
    .map((entry) => entry.params.mode);
  check(
    "fullscreen",
    modeRequests.join(",") === "fullscreen,inline" &&
      fullHeight > inlineHeight + 100 &&
      backHeight === inlineHeight,
    `ui/request-display-mode ${modeRequests.join(" then ")}; chart height inline ${inlineHeight}px, fullscreen ${fullHeight}px, back ${backHeight}px -> ${fullscreen}`,
  );

  await frame.getByRole("button", { name: "Open in Sentry" }).click();
  await page.waitForFunction(() =>
    window.hostLog.some((e) => e.method === "ui/open-link"),
  );
  const openLink = (await page.evaluate(() => window.hostLog)).find(
    (e) => e.method === "ui/open-link",
  );
  check(
    "open-link",
    openLink?.params?.url?.startsWith(`https://${ORG}.sentry.io/`),
    `ui/open-link ${openLink?.params?.url}`,
  );

  // The issue chart: the same view, the issue-platform dataset, the issue
  // page's 4h buckets for 14 days, and a range picker that calls
  // render_issue_chart.
  await mount("light", ISSUE_CHART, issueResult);
  const issueChart = issueResult.structuredContent;
  const issueLegend = await frame.locator(".legend").innerText();
  const issueStats = await frame.locator(".stats").innerText();
  const issueShot = await shot("chart-issue.png");
  check(
    "issue-chart",
    issueTool?._meta?.ui?.resourceUri === uri &&
      issueChart.dataset === "issuePlatform" &&
      issueChart.interval === "4h" &&
      issueChart.series.map((s) => s.label).join() === "Events,Users" &&
      issueChart.series.every((s) => s.values.some((v) => v > 0)) &&
      issueStats.includes("Peak"),
    `${ISSUE_TOOL} names ${issueTool?._meta?.ui?.resourceUri}; ${issueChart.dataset} ${issueChart.query}, ${issueChart.times.length} buckets of ${issueChart.interval}, legend "${issueLegend.replace(/\n/g, " | ")}", stats "${issueStats.replace(/\n/g, " ")}" -> ${issueShot}`,
  );
  await frame.getByRole("button", { name: "7d", exact: true }).click();
  await frame.locator(".subtitle", { hasText: "Last 7 days" }).waitFor();
  await frame.locator('.chart[data-loading="false"]').waitFor();
  const issueRangeCall = (await page.evaluate(() => window.hostLog))
    .filter((entry) => entry.method === "tools/call")
    .at(-1);
  const issueRange = calls.at(-1)?.result?.structuredContent;
  check(
    "issue-range-roundtrip",
    issueRangeCall?.params?.name === ISSUE_TOOL &&
      issueRangeCall.params.arguments.issueId === ISSUE_CHART.issueId &&
      issueRangeCall.params.arguments.period === "7d" &&
      issueRange?.interval === "2h",
    `view called ${issueRangeCall?.params?.name} ${JSON.stringify(issueRangeCall?.params?.arguments)} through the host, got ${issueRange?.times?.length} buckets of ${issueRange?.interval}`,
  );

  const groupedChart = groupedResult.structuredContent;
  const groupedBytes = JSON.stringify(groupedChart).length;
  check(
    "compact-result",
    groupedBytes < GROUPED_BUDGET_BYTES &&
      groupedResult.content[0]?.text?.length === groupedBytes,
    `${groupedChart.series.length} series x ${groupedChart.times.length} buckets: structuredContent ${groupedBytes} bytes, text ${groupedResult.content[0]?.text?.length} bytes (budget ${GROUPED_BUDGET_BYTES})`,
  );
  const counts = groupedChart.series.map((s) => s.count);
  check(
    "top-by-volume",
    counts.length === 5 &&
      counts.slice(0, 3).every((count) => count > 1000) &&
      counts.every((count, i) => i === 0 || count <= counts[i - 1]),
    `p95 by release picks the releases with the most events: ${groupedChart.series.map((s) => `${s.label.slice(0, 7)}=${s.count}`).join(", ")}`,
  );

  await mount("dark", GROUPED_CHART, groupedResult);
  const legend = await frame.locator(".legend").innerText();
  const groupedStats = await frame.locator(".stats").innerText();
  const grouped = await shot("chart-grouped-dark.png");
  check(
    "grouped",
    legend.split("\n").filter(Boolean).length === 5 &&
      groupedChart.peak === null &&
      !groupedStats.includes("Peak"),
    `top groups "${legend.replace(/\n/g, " | ")}", stats "${groupedStats.replace(/\n/g, " ")}", peak ${groupedChart.peak} -> ${grouped}`,
  );

  // The sparsest charted release has data in 4 of 168 buckets. Its empty
  // buckets are null in the result and draw as gaps: 4 dots, no line to 0.
  const sparse = groupedChart.series.at(-1);
  const sparseColor = "#2ba1db";
  const dots = await frame
    .locator(`svg circle[fill="${sparseColor}"][r="2.5"]`)
    .count();
  const lines = await frame
    .locator(`svg path[stroke="${sparseColor}"]`)
    .count();
  const groupedBox = await frame.locator("svg").boundingBox();
  // The left edge of the plot, where the sparse release has no data.
  await page.mouse.move(
    groupedBox.x + 50,
    groupedBox.y + groupedBox.height / 2,
  );
  const gapTooltip = await frame.locator(".tooltip").innerText();
  const withData = sparse.values.filter((v) => v !== null).length;
  check(
    "null-gaps",
    !sparse.values.includes(0) &&
      dots === withData &&
      lines === 0 &&
      gapTooltip.includes("no data"),
    `${sparse.label.slice(0, 7)} has ${withData} of ${sparse.values.length} buckets with data and no 0s; drawn as ${dots} dots and ${lines} lines; tooltip at the left edge "${gapTooltip.replace(/\s+/g, " ")}"`,
  );

  // A host that advertises neither fullscreen nor model context updates.
  await mount("light", ERRORS_CHART, errorsResult, false);
  const fullscreenHidden = await frame
    .getByRole("button", { name: "Fullscreen", exact: true })
    .isHidden();
  await frame.getByRole("button", { name: "1h", exact: true }).click();
  await frame.locator(".subtitle", { hasText: "Last hour" }).waitFor();
  await frame.locator('.chart[data-loading="false"]').waitFor();
  const plainLog = await page.evaluate(() => window.hostLog);
  check(
    "capability-gated",
    fullscreenHidden &&
      plainLog.at(-1)?.method === "tools/call" &&
      plainLog.at(-1)?.params?.arguments?.period === "1h",
    `host without updateModelContext or fullscreen: Fullscreen button hidden=${fullscreenHidden}; after a range change the last host request is ${plainLog.at(-1)?.method}`,
  );

  // The rest of the lifecycle: a theme change, a cancelled call, teardown.
  await page.evaluate(() =>
    window.bridge.sendHostContextChange({ theme: "light" }),
  );
  await frame
    .locator("html[data-theme='light']")
    .waitFor({ state: "attached" });
  await page.evaluate(() =>
    window.bridge.sendToolCancelled({ reason: "verify-toolkit" }),
  );
  const cancelled = await frame.locator(".state.error").innerText();
  const teardown = await page.evaluate(() =>
    window.bridge.teardownResource({ reason: "verify-toolkit" }),
  );
  check(
    "lifecycle",
    cancelled.includes("cancelled") && JSON.stringify(teardown) === "{}",
    `host-context-changed -> light, tool-cancelled -> "${cancelled}", ui/resource-teardown -> ${JSON.stringify(teardown)}`,
  );

  write("host-log.json", await page.evaluate(() => window.hostLog));
  write("calls.json", calls);
  write("console-errors.json", consoleErrors);
  check(
    "default-csp",
    consoleErrors.length === 0,
    `${consoleErrors.length} console errors under the default CSP`,
  );
} catch (error) {
  check(
    "host-run",
    false,
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
} finally {
  await browser?.close();
  await client.close().catch(() => {});
  cleanup();
  writeFileSync(join(out, "server-stderr.txt"), stderr);
}
process.exit(failures > 0 ? 1 : 0);
