/**
 * Types shared by the SvelteKit setup steps.
 */

export type ProjectInfo = {
  dsn: string;
  org: string;
  project: string;
  selfHosted: boolean;
  url: string;
  /** Module `sentrySvelteKit` is imported from; depends on the installed SDK major. */
  vitePluginImportPath: string;
  /** Whether to write the PII-reducing `dataCollection` preset into `Sentry.init` (SDK v11+). */
  reduceDataCollection: boolean;
};
