import {
  boolean,
  description,
  type InferOutput,
  literal,
  number,
  object,
  optional,
  pipe,
  string,
} from "valibot";

/** Safe authentication result exposed to command output and field discovery. */
export const BootstrapResultSchema = object({
  method: literal("oauth"),
  configPath: pipe(string(), description("Path to the stored CLI credentials")),
  user: optional(
    object({
      id: optional(string()),
      name: optional(string()),
      email: optional(string()),
      username: optional(string()),
    }),
  ),
  expiresIn: optional(number()),
  refreshEnabled: boolean(),
});

/** Public result of successful setup-code authentication. */
export type BootstrapResult = InferOutput<typeof BootstrapResultSchema>;
