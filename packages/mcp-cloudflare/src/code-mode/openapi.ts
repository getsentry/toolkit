import source from "./generated/source.json";
import specText from "./generated/openapi.json.txt";

/**
 * The pinned, pre-dereferenced Sentry OpenAPI schema, shipped with the deploy.
 * `scripts/generate-openapi-spec.mjs` writes it; nothing fetches it at runtime.
 * It is a Text module, so loading it costs a string, not a parse.
 */
export const SPEC_TEXT: string = specText;

/** The sentry-api-schema commit the schema comes from. */
export const SPEC_COMMIT: string = source.commit;

let spec: Record<string, unknown> | undefined;

/** The parsed schema for authorization, parsed once per isolate on first use. */
export function getSpec(): Record<string, unknown> {
  spec ??= JSON.parse(SPEC_TEXT) as Record<string, unknown>;
  return spec;
}
