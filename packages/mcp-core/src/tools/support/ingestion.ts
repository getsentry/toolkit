/**
 * Ingestion delay in structured time series results. Imports only zod, so the
 * chart view can share it.
 */
import { z } from "zod";
import type { IngestionMeta } from "../../api-client/schema";

export const ingestionSchema = z
  .object({
    status: z.string(),
    delaySeconds: z.number().nullable(),
    completeThrough: z.string().nullable(),
  })
  .nullable();

export function toStructuredIngestion(
  ingestion: IngestionMeta | undefined,
): z.output<typeof ingestionSchema> {
  return ingestion
    ? {
        status: ingestion.status,
        delaySeconds: ingestion.delaySeconds ?? null,
        completeThrough:
          ingestion.completeThrough === undefined
            ? null
            : new Date(ingestion.completeThrough).toISOString(),
      }
    : null;
}
