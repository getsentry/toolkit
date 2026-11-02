export function parseEvalJsonAnswer(text: string): unknown {
  const fenced = text.split("```");
  if (fenced.length > 1) {
    if (fenced.length !== 3) {
      throw new SyntaxError("Final answer must contain exactly one JSON fence");
    }
    // Prefer the explicit answer over braces in surrounding explanations.
    return JSON.parse(fenced[1].trim().replace(/^json\b\s*/i, ""));
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new SyntaxError("Final answer must include the saved values as JSON");
  }
  return JSON.parse(text.slice(start, end + 1));
}
