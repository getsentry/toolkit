/**
 * Code Mappings Bulk Upload API
 *
 * Uploads code mappings (stack trace root → source code root) via the
 * bulk code-mappings endpoint. Code mappings enable source context,
 * suspect commits, and stack trace linking in Sentry.
 *
 * Endpoint: `POST /api/0/organizations/{org}/code-mappings/bulk/`
 * Auth: requires `org:ci` scope.
 */

import {
  array,
  type InferOutput,
  minLength,
  nullish,
  number,
  object,
  pipe,
  string,
} from "valibot";

import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";
import { apiRequestToRegion } from "./infrastructure.js";

const log = logger.withTag("api.code-mappings");

// Schemas

/** A single code mapping entry. */
export const CodeMappingSchema = object({
  stackRoot: pipe(string(), minLength(1)),
  sourceRoot: pipe(string(), minLength(1)),
});

export type CodeMapping = InferOutput<typeof CodeMappingSchema>;

/** Per-mapping result from the server. */
const CodeMappingResultSchema = object({
  stackRoot: string(),
  sourceRoot: string(),
  status: string(),
  detail: nullish(string()),
});

/** Bulk upload response from the server. */
const BulkCodeMappingsResponseSchema = object({
  created: number(),
  updated: number(),
  errors: number(),
  mappings: array(CodeMappingResultSchema),
});

export type BulkCodeMappingsResponse = InferOutput<
  typeof BulkCodeMappingsResponseSchema
>;

export type CodeMappingResult = InferOutput<typeof CodeMappingResultSchema>;

// Constants

/** Maximum mappings per API request. */
const BATCH_SIZE = 300;

// Types

/** Options for {@link uploadCodeMappings}. */
export type CodeMappingsUploadOptions = {
  org: string;
  project: string;
  repository: string;
  defaultBranch: string;
  mappings: CodeMapping[];
};

/** Merged response across batches. */
export type MergedCodeMappingsResponse = {
  created: number;
  updated: number;
  errors: number;
  mappings: CodeMappingResult[];
};

// API Function

/**
 * Upload code mappings to Sentry via the bulk endpoint.
 *
 * Sends mappings in batches of 300 and merges the per-batch responses
 * into a single result.
 *
 * @param options - Upload configuration
 * @returns Merged response with created/updated/errors counts
 */
export async function uploadCodeMappings(
  options: CodeMappingsUploadOptions
): Promise<MergedCodeMappingsResponse> {
  const { org, project, repository, defaultBranch, mappings } = options;
  const regionUrl = await resolveOrgRegion(org);
  const endpoint = `organizations/${org}/code-mappings/bulk/`;

  const merged: MergedCodeMappingsResponse = {
    created: 0,
    updated: 0,
    errors: 0,
    mappings: [],
  };

  // Batch mappings
  for (let i = 0; i < mappings.length; i += BATCH_SIZE) {
    const batch = mappings.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(mappings.length / BATCH_SIZE);

    if (totalBatches > 1) {
      log.debug(
        `Uploading batch ${batchNum}/${totalBatches} (${batch.length} mappings)`
      );
    }

    const { data } = await apiRequestToRegion<BulkCodeMappingsResponse>(
      regionUrl,
      endpoint,
      {
        method: "POST",
        body: {
          project,
          repository,
          defaultBranch,
          mappings: batch,
        },
        schema: BulkCodeMappingsResponseSchema,
      }
    );

    merged.created += data.created;
    merged.updated += data.updated;
    merged.errors += data.errors;
    merged.mappings.push(...data.mappings);
  }

  return merged;
}
