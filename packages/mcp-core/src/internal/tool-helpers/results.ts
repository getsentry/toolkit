import type { StructuredToolOutput } from "../../tools/types";

/**
 * Tool result packing policy
 *
 * - `structuredContent` is the source of truth when present.
 * - `content` text is a compatibility view of that same answer.
 * - Never put unique product data in only one side. If both fields are present,
 *   they must be equivalent. Form-only differences (`structuredContent` vs its
 *   serialized JSON text) are fine; a second answer that exists in only one
 *   field is a bug.
 * - Prefer `structuredResult(payload)` for data tools. The server generates
 *   `content` as compact JSON of the same payload.
 * - Markdown-only tools should return markdown and omit `structuredContent`
 *   until they have a real structured payload. Do not attach sparse structured
 *   side-channels (for example suggestedActions alone) on top of markdown.
 */

/**
 * Marks a tool result as structured-only. The server generates compatibility
 * text for clients that do not read structuredContent yet.
 *
 * The returned payload is the full answer. Do not use this helper to ship a
 * partial hint while leaving the real answer only in handwritten markdown.
 *
 * `T` comes from where the result is returned (the tool's `outputSchema` via
 * `ToolConfig`, or the caller's declared return type), never from the payload.
 * The payload is then checked against that type, so missing and mistyped
 * fields fail tsc. Excess-property checks only apply to a fresh object
 * literal: `structuredResult({ ...upstream })` and `structuredResult(payload)`
 * accept extra fields, so map fields explicitly.
 */
export function structuredResult<T extends Record<string, unknown>>(
  structuredContent: NoInfer<T>,
): StructuredToolOutput<T> {
  return {
    structuredContent,
  };
}
