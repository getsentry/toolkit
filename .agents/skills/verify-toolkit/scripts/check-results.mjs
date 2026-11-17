#!/usr/bin/env node
// Check mcp-call.mjs evidence against map claims. Prints one PASS/FAIL line
// per claim, appends them to <DIR>/checks.txt, and exits 1 on any FAIL.
//   check-results.mjs responses DIR   mcp-tool-responses claims, per call
//   check-results.mjs surface DIR     mcp-tool-surface claims
//   check-results.mjs read-only DIR   mcp-access#inspect-read-only
//   check-results.mjs scoped DIR      mcp-access#scope-hides-org
//   check-results.mjs subset WIDE DIR mcp-access#skills-narrow (DIR lists fewer tools)
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Tools every skill keeps, though they send data to Sentry (design/mcp-access.md). */
const EVERY_SKILL_WRITES = new Set([
  "submit_feedback_to_sentry_team",
  "onboarding_status_update",
]);
const GATEWAY_TOOLS = ["search_sentry_tools", "execute_sentry_tool"];
const PLACEHOLDERS = ["undefined", "[object Object]", "NaN"];
const MAX_INSTRUCTIONS = 1500;
const MAX_SUGGESTED_ACTIONS = 3;

const [mode, ...dirs] = process.argv.slice(2);
const dir = dirs.at(-1);
if (!dir) {
  console.error(
    "usage: check-results.mjs responses|surface|read-only|scoped DIR | subset WIDE DIR",
  );
  process.exit(2);
}
const readJson = (d, name) => JSON.parse(readFileSync(join(d, name), "utf8"));
const listed = (d) => readJson(d, "tools-list.json");
const toolNames = (d) => listed(d).tools.map((tool) => tool.name);

const lines = [];
function check(claim, problems, detail = "") {
  const ok = problems.length === 0;
  lines.push(
    `${ok ? "PASS" : "FAIL"} ${claim}${detail ? ` (${detail})` : ""}${ok ? "" : `: ${problems.join("; ")}`}`,
  );
}

function responses() {
  const { tools } = listed(dir);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const calls = readdirSync(dir)
    .filter((file) => /^call-\d+-.+\.json$/.test(file))
    .sort();
  for (const file of calls) {
    const { request, result } = readJson(dir, file);
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const declaresSchema = Boolean(byName.get(request.name)?.outputSchema);
    if (result.isError) {
      check(
        "mcp-tool-responses#tool-error",
        result.structuredContent ? ["error result has structuredContent"] : [],
        file,
      );
    } else if (declaresSchema) {
      const sc = result.structuredContent;
      check(
        "mcp-tool-responses#structured-text-match",
        !sc
          ? ["no structuredContent"]
          : text === JSON.stringify(sc)
            ? []
            : ["text is not the compact JSON of structuredContent"],
        file,
      );
      const actions = sc?.suggestedActions ?? [];
      const problems =
        actions.length > MAX_SUGGESTED_ACTIONS
          ? [`${actions.length} actions`]
          : [];
      for (const action of actions) {
        if (action.type !== "tool_call") problems.push(`type ${action.type}`);
        if (!byName.has(action.toolName))
          problems.push(`${action.toolName} is not in tools/list`);
        if (!action.arguments || Object.keys(action.arguments).length === 0)
          problems.push(`${action.toolName} has no arguments`);
      }
      check(
        "mcp-tool-responses#suggested-actions-callable",
        problems,
        `${file}, ${actions.length} actions`,
      );
      if (Array.isArray(sc?.sideQuests)) {
        check(
          "mcp-tool-responses#side-quest-fix",
          sc.sideQuests
            .filter(
              (quest) => !quest.tip || !quest.docs?.startsWith("https://"),
            )
            .map((quest) => `${quest.id} has no tip or docs link`),
          `${file}, ${sc.sideQuests.length} side quests`,
        );
      }
    } else {
      const problems = [];
      if (result.structuredContent)
        problems.push("markdown tool returned structuredContent");
      if (!text.startsWith("# "))
        problems.push("text does not start with a # title");
      check("mcp-tool-responses#markdown-only", problems, file);
      const found = PLACEHOLDERS.filter((token) =>
        new RegExp(
          `(^|[^\\w])${token.replace(/[[\]]/g, "\\$&")}([^\\w]|$)`,
        ).test(text),
      );
      check(
        "mcp-tool-responses#no-placeholders",
        found.map((token) => `contains ${token}`),
        file,
      );
    }
  }
}

function surface() {
  const { tools, nextCursor } = listed(dir);
  const { instructions = "" } = readJson(dir, "initialize.json");
  check(
    "mcp-tool-surface#lists-all",
    GATEWAY_TOOLS.filter((name) => tools.some((tool) => tool.name === name)),
    `${tools.length} tools`,
  );
  check(
    "mcp-tool-surface#hints-set",
    tools.flatMap((tool) =>
      ["readOnlyHint", "destructiveHint", "openWorldHint"]
        .filter((hint) => typeof tool.annotations?.[hint] !== "boolean")
        .map((hint) => `${tool.name} has no ${hint}`),
    ),
  );
  const titles = tools.map((tool) => tool.title);
  check(
    "mcp-tool-surface#unique-titles",
    tools
      .filter((tool, i) => !tool.title || titles.indexOf(tool.title) !== i)
      .map((tool) => `${tool.name}: ${tool.title ?? "no title"}`),
  );
  check(
    "mcp-tool-surface#one-page",
    nextCursor ? [`nextCursor ${nextCursor}`] : [],
  );
  check(
    "mcp-tool-surface#instructions-short",
    instructions.length > MAX_INSTRUCTIONS
      ? [`${instructions.length} characters`]
      : [],
    `${instructions.length} characters`,
  );
}

function readOnly() {
  const writes = listed(dir).tools.filter(
    (tool) =>
      !tool.annotations?.readOnlyHint && !EVERY_SKILL_WRITES.has(tool.name),
  );
  check(
    "mcp-access#inspect-read-only",
    writes.map((tool) => `${tool.name} is not read-only`),
  );
}

function scoped() {
  const { tools } = listed(dir);
  const problems = tools
    .filter((tool) => tool.name === "find_organizations")
    .map(() => "find_organizations is listed");
  for (const tool of tools) {
    if (tool.inputSchema?.properties?.organizationSlug)
      problems.push(`${tool.name} takes organizationSlug`);
  }
  check("mcp-access#scope-hides-org", problems);
}

function subset() {
  const wide = new Set(toolNames(dirs[0]));
  const narrow = toolNames(dir);
  const extra = narrow.filter((name) => !wide.has(name));
  const removed = [...wide].filter((name) => !narrow.includes(name));
  const problems = extra.map((name) => `${name} is not in ${dirs[0]}`);
  if (removed.length === 0) problems.push("nothing was removed");
  check(
    "mcp-access#skills-narrow",
    problems,
    `${narrow.length} of ${wide.size} tools; removed ${removed.join(", ")}`,
  );
}

const modes = { responses, surface, "read-only": readOnly, scoped, subset };
if (!modes[mode]) {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
modes[mode]();
console.log(lines.join("\n"));
appendFileSync(join(dir, "checks.txt"), `${lines.join("\n")}\n`);
process.exit(lines.some((line) => line.startsWith("FAIL")) ? 1 : 0);
