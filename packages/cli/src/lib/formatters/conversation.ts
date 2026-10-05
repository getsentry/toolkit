/**
 * Agent conversations formatters
 *
 * Human-readable formatting for conversation list and detail views.
 * Transcript parsing logic ported from sentry-mcp get-ai-conversation-details.
 */

import type {
  AgentConversationSpan,
  ConversationListItem,
} from "../../types/conversation.js";
import {
  colorTag,
  escapeMarkdownCell,
  escapeMarkdownInline,
  mdKvTable,
  renderMarkdown,
  safeCodeSpan,
} from "./markdown.js";
import { type Column, formatTable } from "./table.js";

// ---------------------------------------------------------------------------
// List formatter
// ---------------------------------------------------------------------------

function truncate(value: string, max = 60): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function formatTimestamp(epochSeconds: number): string {
  if (epochSeconds === 0) {
    return "—";
  }
  return new Date(epochSeconds * 1000).toLocaleString();
}

/**
 * Minimum terminal width (columns) to show the full conversation table.
 * Below this, Tools/Errs/User are dropped so the core ID/Title/Started/
 * Tokens/First Input columns don't truncate aggressively.
 */
const WIDE_TABLE_MIN_TERM_WIDTH = 100;

const ID_COLUMN: Column<ConversationListItem> = {
  header: "ID",
  value: (c) => {
    const id = escapeMarkdownCell(truncate(c.conversationId, 40));
    return c.webUrl ? `[${id}](${c.webUrl})` : id;
  },
  truncate: true,
  shrinkable: false,
};

const TITLE_COLUMN: Column<ConversationListItem> = {
  header: "Title",
  value: (c) => (c.title ? escapeMarkdownCell(truncate(c.title, 40)) : "—"),
  truncate: true,
};

const STARTED_COLUMN: Column<ConversationListItem> = {
  header: "Started",
  value: (c) => formatTimestamp(c.startTimestamp),
};

const TOKENS_COLUMN: Column<ConversationListItem> = {
  header: "Tokens",
  value: (c) => String(c.totalTokens),
  align: "right",
};

const TOOLS_COLUMN: Column<ConversationListItem> = {
  header: "Tools",
  value: (c) => String(c.toolCalls),
  align: "right",
};

const ERRS_COLUMN: Column<ConversationListItem> = {
  header: "Errs",
  value: (c) => String(c.errors),
  align: "right",
};

const USER_COLUMN: Column<ConversationListItem> = {
  header: "User",
  value: (c) => escapeMarkdownCell(c.user?.email ?? c.user?.username ?? "—"),
};

const FIRST_INPUT_COLUMN: Column<ConversationListItem> = {
  header: "First Input",
  value: (c) =>
    c.firstInput ? escapeMarkdownCell(truncate(c.firstInput)) : "—",
  truncate: true,
};

/**
 * Select conversation table columns for the current terminal width. Wide
 * terminals get the full set; narrow ones (piped output defaults to 80) drop
 * Tools/Errs/User to keep the remaining columns readable. Title stays on
 * both widths so stored conversation names remain visible.
 */
function selectConversationColumns(): Column<ConversationListItem>[] {
  const termWidth = process.stdout.columns || 80;
  if (termWidth >= WIDE_TABLE_MIN_TERM_WIDTH) {
    return [
      ID_COLUMN,
      TITLE_COLUMN,
      STARTED_COLUMN,
      TOKENS_COLUMN,
      TOOLS_COLUMN,
      ERRS_COLUMN,
      USER_COLUMN,
      FIRST_INPUT_COLUMN,
    ];
  }
  return [
    ID_COLUMN,
    TITLE_COLUMN,
    STARTED_COLUMN,
    TOKENS_COLUMN,
    FIRST_INPUT_COLUMN,
  ];
}

export function formatConversationTable(items: ConversationListItem[]): string {
  return formatTable(items, selectConversationColumns(), { truncate: true });
}

// ---------------------------------------------------------------------------
// Transcript parsing (ported from sentry-mcp get-ai-conversation-details)
// ---------------------------------------------------------------------------

export type ToolCall = {
  name: string;
  spanId: string;
  timestamp: number;
  durationMs: number;
  status?: string | null;
};

export type ConversationTurn = {
  turn: number;
  spanId: string;
  traceId: string;
  started: number;
  ended: number;
  durationMs: number;
  userContent?: string | null;
  assistantContent?: string | null;
  toolCalls: ToolCall[];
  model?: string | null;
  agentName?: string | null;
  totalTokens: number;
  status?: string | null;
};

function numeric(value: string | number | null | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getOperationType(span: AgentConversationSpan): string | undefined {
  const explicit = span["gen_ai.operation.type"];
  if (explicit) {
    return explicit;
  }

  const spanName = span["span.name"];
  if (!spanName?.startsWith("gen_ai.")) {
    return;
  }
  if (spanName === "gen_ai.execute_tool") {
    return "tool";
  }
  if (
    spanName === "gen_ai.invoke_agent" ||
    spanName === "gen_ai.create_agent"
  ) {
    return "agent";
  }
  if (spanName === "gen_ai.handoff") {
    return "handoff";
  }
  return "ai_client";
}

function parseJson(value: string): unknown {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringifyContent(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const r = part as Record<string, unknown>;
          if (typeof r.text === "string") {
            return r.text;
          }
          if (typeof r.content === "string") {
            return r.content;
          }
        }
        return null;
      })
      .filter((p): p is string => Boolean(p));
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    if (typeof r.text === "string") {
      return r.text;
    }
    if (typeof r.content === "string") {
      return r.content;
    }
    if (typeof r.message === "string") {
      return r.message;
    }
  }
  return value === null ? null : JSON.stringify(value);
}

function collectMessages(value: unknown): { role?: string; content: string }[] {
  const source =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).messages)
      ? (value as Record<string, unknown>).messages
      : value;

  if (!Array.isArray(source)) {
    const content = stringifyContent(source);
    return content ? [{ content }] : [];
  }

  return source
    .map((msg) => {
      if (typeof msg === "string") {
        return { content: msg };
      }
      if (!msg || typeof msg !== "object") {
        return null;
      }
      const r = msg as Record<string, unknown>;
      const raw = r.content ?? r.text ?? r.parts;
      if (raw === null || raw === undefined) {
        return null;
      }
      const content = stringifyContent(raw);
      if (!content) {
        return null;
      }
      return {
        role: typeof r.role === "string" ? r.role : undefined,
        content,
      };
    })
    .filter((m): m is { role?: string; content: string } => Boolean(m));
}

function extractUserContent(span: AgentConversationSpan): string | null {
  const raw =
    span["gen_ai.input.messages"] ?? span["gen_ai.request.messages"] ?? null;
  if (!raw) {
    return null;
  }
  if (raw === "[Filtered]") {
    return raw;
  }
  const messages = collectMessages(parseJson(raw));
  const userMsg = messages.findLast((m) => m.role === "user");
  return userMsg?.content ?? messages.at(-1)?.content ?? null;
}

function extractAssistantContent(span: AgentConversationSpan): string | null {
  const outputMessages = span["gen_ai.output.messages"];
  if (outputMessages) {
    if (outputMessages === "[Filtered]") {
      return outputMessages;
    }
    const messages = collectMessages(parseJson(outputMessages));
    const assistantMsg = messages.findLast((m) => m.role === "assistant");
    const content = assistantMsg?.content ?? messages.at(-1)?.content;
    if (content) {
      return content;
    }
  }
  return span["gen_ai.response.text"] ?? span["gen_ai.response.object"] ?? null;
}

export function extractTurns(
  spans: AgentConversationSpan[]
): ConversationTurn[] {
  const sorted = [...spans].sort(
    (a, b) => a["precise.start_ts"] - b["precise.start_ts"]
  );
  const aiClientSpans = sorted.filter(
    (s) => getOperationType(s) === "ai_client"
  );
  const toolSpans = sorted.filter((s) => getOperationType(s) === "tool");

  return aiClientSpans.map((span, index) => {
    const nextSpan = aiClientSpans[index + 1];
    const nextTs = nextSpan
      ? nextSpan["precise.start_ts"]
      : Number.POSITIVE_INFINITY;
    const toolCalls = toolSpans
      .filter((ts) => {
        const t = ts["precise.start_ts"];
        return t >= span["precise.start_ts"] && t < nextTs;
      })
      .map((ts) => ({
        name: ts["gen_ai.tool.name"] ?? "unknown",
        spanId: ts.span_id,
        timestamp: ts["precise.start_ts"],
        durationMs: Math.round(
          (ts["precise.finish_ts"] - ts["precise.start_ts"]) * 1000
        ),
        status: ts["span.status"],
      }));

    return {
      turn: index + 1,
      spanId: span.span_id,
      traceId: span.trace,
      started: span["precise.start_ts"],
      ended: span["precise.finish_ts"],
      durationMs: Math.round(
        (span["precise.finish_ts"] - span["precise.start_ts"]) * 1000
      ),
      userContent: extractUserContent(span),
      assistantContent: extractAssistantContent(span),
      toolCalls,
      model: span["gen_ai.response.model"] ?? span["gen_ai.request.model"],
      agentName: span["gen_ai.agent.name"],
      totalTokens: numeric(span["gen_ai.usage.total_tokens"]),
      status: span["span.status"],
    };
  });
}

// ---------------------------------------------------------------------------
// Human formatter for transcript view
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}

function formatEpoch(ts: number): string {
  if (!Number.isFinite(ts) || ts === 0) {
    return "—";
  }
  return new Date(ts * 1000).toISOString();
}

function appendContentBlock(
  lines: string[],
  label: string,
  content: string
): void {
  lines.push(`**${label}**`);
  lines.push("");
  for (const line of truncate(content, 600).split("\n")) {
    lines.push(escapeMarkdownInline(line));
  }
  lines.push("");
}

function formatTurnHuman(turn: ConversationTurn): string {
  const meta = [
    turn.model ? escapeMarkdownInline(turn.model) : null,
    turn.agentName ? escapeMarkdownInline(turn.agentName) : null,
    turn.totalTokens > 0 ? `${turn.totalTokens} tokens` : null,
    formatDuration(turn.durationMs),
  ]
    .filter(Boolean)
    .join(" | ");

  const lines: string[] = [];
  lines.push(`### Turn ${turn.turn} — ${formatEpoch(turn.started)}`);
  lines.push("");
  if (meta) {
    lines.push(colorTag("muted", meta));
    lines.push("");
  }

  if (turn.userContent) {
    appendContentBlock(lines, "user", turn.userContent);
  }
  if (turn.assistantContent) {
    appendContentBlock(lines, "assistant", turn.assistantContent);
  }

  if (turn.toolCalls.length > 0) {
    lines.push("**tools**");
    lines.push("");
    for (const tc of turn.toolCalls) {
      const status =
        tc.status && tc.status !== "ok"
          ? ` (${escapeMarkdownInline(tc.status)})`
          : "";
      lines.push(
        `- ${safeCodeSpan(tc.name)} — ${formatDuration(tc.durationMs)}${status}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export type TranscriptResult = {
  conversationId: string;
  org: string;
  /** Stored conversation title, or null when none has been titled yet. */
  title: string | null;
  turns: ConversationTurn[];
  totalTokens: number;
  spanCount: number;
  projects: string[];
  startTimestamp: number;
  endTimestamp: number;
  truncated?: boolean;
};

export function formatTranscriptResult(result: TranscriptResult): string {
  if (result.spanCount === 0) {
    const id = escapeMarkdownInline(result.conversationId);
    const titled = result.title
      ? `${id} (${escapeMarkdownInline(result.title)})`
      : id;
    return `No spans found for conversation ${titled} in the last 30 days.`;
  }

  // Keep the conversation ID in the heading (needed to re-run `conversation
  // view`). Surface title as a table row so it is not duplicated in the heading.
  const rows: [string, string][] = [
    ["Org", escapeMarkdownCell(result.org)],
    ["Projects", result.projects.map(escapeMarkdownCell).join(", ") || "—"],
    ["Started", formatEpoch(result.startTimestamp)],
    ["Ended", formatEpoch(result.endTimestamp)],
    ["Turns", String(result.turns.length)],
    ["Spans", String(result.spanCount)],
    ["Tokens", String(result.totalTokens)],
  ];
  if (result.title) {
    rows.unshift(["Title", escapeMarkdownCell(result.title)]);
  }

  const lines: string[] = [
    `# Agent Conversation: ${escapeMarkdownInline(result.conversationId)}`,
    "",
    mdKvTable(rows),
    "",
    ...result.turns.map(formatTurnHuman),
  ];
  if (result.truncated) {
    lines.push(
      colorTag(
        "yellow",
        "⚠ Transcript truncated — the conversation exceeds the pagination limit."
      )
    );
  }
  return renderMarkdown(lines.join("\n"));
}

export function buildTranscriptResult(
  conversationId: string,
  org: string,
  spans: AgentConversationSpan[],
  title: string | null = null
): TranscriptResult {
  const turns = extractTurns(spans);
  return {
    conversationId,
    org,
    title,
    turns,
    // Sum tokens per turn (ai_client spans only). Summing every span would
    // double-count parent invoke_agent spans that aggregate child usage.
    totalTokens: turns.reduce((sum, t) => sum + t.totalTokens, 0),
    spanCount: spans.length,
    projects: [...new Set(spans.map((s) => s.project))].sort(),
    startTimestamp:
      spans.length > 0
        ? spans.reduce(
            (min, s) => Math.min(min, s["precise.start_ts"]),
            Number.POSITIVE_INFINITY
          )
        : 0,
    endTimestamp:
      spans.length > 0
        ? spans.reduce(
            (max, s) => Math.max(max, s["precise.finish_ts"]),
            Number.NEGATIVE_INFINITY
          )
        : 0,
  };
}
