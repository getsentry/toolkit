/**
 * Output schemas of the `sentry trial` commands.
 */

import {
  description,
  type InferOutput,
  nullable,
  number,
  object,
  picklist,
  pipe,
  string,
} from "valibot";
import { ProductTrialSchema } from "../types/sentry.js";

const { category, isStarted, lengthDays, startDate, endDate } =
  ProductTrialSchema.pipe[0].entries;

/**
 * JSON output of `trial list`, one per trial: the API trial's fields plus the
 * ones the CLI derives (name, status, daysRemaining).
 */
export const TrialListEntrySchema = object({
  name: pipe(
    string(),
    description('CLI trial name (e.g. seer), or "plan" for the plan trial'),
  ),
  category,
  status: pipe(
    picklist(["available", "active", "expired"]),
    description("Trial status"),
  ),
  daysRemaining: pipe(
    nullable(number()),
    description("Days left on an active trial"),
  ),
  isStarted,
  lengthDays,
  startDate,
  endDate,
});

/** JSON output of one trial of `trial list`. */
export type TrialListEntryOutput = InferOutput<typeof TrialListEntrySchema>;
