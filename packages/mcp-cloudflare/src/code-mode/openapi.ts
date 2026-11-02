import source from "./generated/source.json";
import specText from "./generated/openapi.json.txt";

/**
 * The pre-dereferenced Sentry OpenAPI schema of the catalog's `@sentry/api`
 * release, shipped with the deploy. `scripts/generate-openapi-spec.mjs`
 * writes it; nothing fetches it at runtime. It is a Text module, so loading
 * it costs a string, not a parse.
 */
export const SPEC_TEXT: string = specText;

/** The `@sentry/api` release the schema comes from, as the CLI uses it. */
export const SPEC_VERSION: string = source.version;

let spec: Record<string, unknown> | undefined;

/** The parsed schema for authorization, parsed once per isolate on first use. */
export function getSpec(): Record<string, unknown> {
  spec ??= JSON.parse(SPEC_TEXT) as Record<string, unknown>;
  return spec;
}
