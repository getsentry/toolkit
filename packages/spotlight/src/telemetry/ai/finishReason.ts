/** Decode the convention's JSON array while retaining older plain reasons. */
export function extractFinishReason(
  finishReasons: unknown,
): string | undefined {
  if (Array.isArray(finishReasons)) {
    const first = finishReasons[0];
    return typeof first === "string" && first.trim() ? first.trim() : undefined;
  }
  if (typeof finishReasons === "string" && finishReasons.trim()) {
    const text = finishReasons.trim();
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? extractFinishReason(parsed) : undefined;
    } catch {
      // Older SDKs also send a plain reason; truncated JSON is not one.
      return ["[", "{", '"'].includes(text[0]) ? undefined : text;
    }
  }
  return undefined;
}
