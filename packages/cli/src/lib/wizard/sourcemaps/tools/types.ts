/**
 * Options the source map upload tool setups take.
 */

export type SourceMapUploadToolConfigurationOptions = {
  selfHosted: boolean;
  url: string;
  authToken: string;
  orgSlug: string;
  projectSlug: string;
};
