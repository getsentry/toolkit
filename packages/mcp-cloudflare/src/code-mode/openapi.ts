import type { CatalogOperation } from "./access";
import operations from "./generated/operations.json";
import source from "./generated/source.json";
import specText from "./generated/openapi.json.txt";

/**
 * The pre-dereferenced Sentry OpenAPI schema of the catalog's `@sentry/api`
 * release, shipped with the deploy for `search_sentry_api`.
 * `scripts/generate-openapi-spec.mjs` writes it; nothing fetches it at
 * runtime. It is a Text module, so loading it costs a string, not a parse.
 */
export const SPEC_TEXT: string = specText;

/** The `@sentry/api` release the schema comes from, as the CLI uses it. */
export const SPEC_VERSION: string = source.version;

/** Method and path of each operation in that release, for authorization. */
export const OPERATIONS = operations as CatalogOperation[];
