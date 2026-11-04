import type {
  Diagnostic,
  DiagnosticCode,
  IngestCounts,
  IngestOutcome,
  IngestResult,
} from "../contracts.ts";

export const EMPTY_COUNTS: IngestCounts = Object.freeze({
  events: 0,
  spans: 0,
  logs: 0,
  skippedItems: 0,
  duplicateEvents: 0,
});
export function diagnostic(
  code: DiagnosticCode,
  message: string,
  details: Partial<Omit<Diagnostic, "code" | "message">> = {},
): Diagnostic {
  return Object.freeze({ code, message, severity: "error", ...details });
}
export function reportDiagnostic(
  observer: ((item: Diagnostic) => void) | undefined,
  item: Diagnostic,
) {
  try {
    observer?.(item);
  } catch {
    /* Observers never change capture outcomes. */
  }
}
export function receipt(
  outcome: IngestOutcome,
  metadata: {
    revision: number;
    retained?: boolean;
    counts?: Partial<IngestCounts>;
  },
): IngestResult {
  return Object.freeze({
    ...outcome,
    diagnostics: Object.freeze(
      (outcome.diagnostics ?? []).map((item) => Object.freeze({ ...item })),
    ),
    revision: metadata.revision,
    retained: metadata.retained ?? false,
    counts: Object.freeze({ ...EMPTY_COUNTS, ...metadata.counts }),
  }) as IngestResult;
}
