/**
 * Formats untrusted text as a Markdown code span.
 *
 * The fence is one backtick longer than the longest backtick run in the value,
 * so the content cannot close the span early. Line breaks become spaces, as
 * CommonMark would render them, so the value cannot start a new block.
 */
export function formatInlineCode(value: string): string {
  const singleLine = value.replace(/\r\n?|\n/g, " ");
  const backtickRuns = singleLine.match(/`+/g) ?? [];
  const fenceLength =
    backtickRuns.reduce((max, run) => Math.max(max, run.length), 0) + 1;
  const fence = "`".repeat(fenceLength);
  const needsPadding = singleLine.startsWith("`") || singleLine.endsWith("`");
  return needsPadding
    ? `${fence} ${singleLine} ${fence}`
    : `${fence}${singleLine}${fence}`;
}
