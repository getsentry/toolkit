/** Wire contracts verified against Sentry's Seer Explorer UI and endpoints. */
import {
  array,
  boolean,
  type InferOutput,
  looseObject,
  nullable,
  number,
  object,
  optional,
  picklist,
  record,
  string,
  union,
  unknown,
} from "valibot";

const DiffLineSchema = object({
  diff_line_no: nullable(number()),
  line_type: picklist(["+", "-", " "]),
  source_line_no: nullable(number()),
  target_line_no: nullable(number()),
  value: string(),
});
export const FilePatchSchema = object({
  added: number(),
  removed: number(),
  path: string(),
  source_file: string(),
  target_file: string(),
  type: picklist(["A", "M", "D"]),
  hunks: array(
    object({
      lines: array(DiffLineSchema),
      section_header: string(),
      source_length: number(),
      source_start: number(),
      target_length: number(),
      target_start: number(),
    }),
  ),
});
export const ExplorerFilePatchSchema = object({
  code_url: optional(nullable(string())),
  diff: string(),
  patch: FilePatchSchema,
  repo_name: string(),
});
export type ExplorerFilePatch = InferOutput<typeof ExplorerFilePatchSchema>;
export const PendingUserInputSchema = object({
  id: string(),
  input_type: string(),
  data: record(string(), unknown()),
});
export type PendingUserInput = InferOutput<typeof PendingUserInputSchema>;
export const QuestionDataSchema = object({
  questions: array(
    object({
      question: string(),
      options: array(object({ label: string(), description: string() })),
    }),
  ),
});
export const FileApprovalDataSchema = object({
  patches: array(object({ patch: FilePatchSchema, repo_name: string() })),
});
export const UserInputResponseSchema = object({
  input_id: string(),
  response_data: union([
    object({ answers: array(string()) }),
    object({ decisions: array(boolean()) }),
  ]),
});
export type UserInputResponse = InferOutput<typeof UserInputResponseSchema>;
export type SeerResponseData = UserInputResponse["response_data"];
export const ExplorerBlockSchema = looseObject({
  id: string(),
  message: optional(
    looseObject({ content: nullable(string()), role: string() }),
  ),
  file_patches: optional(nullable(array(ExplorerFilePatchSchema))),
  merged_file_patches: optional(nullable(array(ExplorerFilePatchSchema))),
});
export type ExplorerBlock = InferOutput<typeof ExplorerBlockSchema>;
export const ExplorerSessionSchema = looseObject({
  status: string(),
  blocks: optional(array(ExplorerBlockSchema)),
  pending_user_input: optional(nullable(PendingUserInputSchema)),
  repo_pr_states: optional(
    record(
      string(),
      looseObject({
        repo_name: string(),
        pr_url: optional(nullable(string())),
        pr_creation_status: optional(nullable(string())),
        pr_creation_error: optional(nullable(string())),
      }),
    ),
  ),
});
export type ExplorerSession = InferOutput<typeof ExplorerSessionSchema>;
export const ExplorerResponseSchema = object({
  session: nullable(ExplorerSessionSchema),
  sentry_run_id: optional(nullable(string())),
});
export type FixResult = {
  run_id: string | number;
  status: string;
  pending_user_input: PendingUserInput | null;
  patches: ExplorerFilePatch[];
  pr_urls: string[];
  next_action?: string;
  error?: string;
};
