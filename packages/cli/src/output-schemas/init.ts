/**
 * Output schema of `sentry init`.
 */

import { description, type InferOutput, object, pipe, string } from "valibot";

/** `--fields` / SKILL.md documentation schema for the setup guide. */
export const InitOutputSchema = object({
  guide: pipe(string(), description("The setup guide's Markdown source")),
});

/** What `sentry init` outputs. */
export type InitOutput = InferOutput<typeof InitOutputSchema>;
