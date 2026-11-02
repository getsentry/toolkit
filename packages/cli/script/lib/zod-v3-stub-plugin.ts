/**
 * esbuild plugin that replaces `zod/v3` with a small stub.
 *
 * Everything we bundle builds schemas with Zod 4, so Zod 3 code never runs.
 * Two dependencies still import `zod/v3`, and only for Zod 3 inputs:
 *
 * - `@ai-sdk/provider-utils`: `zodSchema()` sends Zod 4 schemas (`_zod`) to
 *   `zod4Schema()`. Only `zod3Schema()` and its bundled zod-to-json-schema
 *   read `ZodFirstPartyTypeKind`.
 * - `@mastra/schema-compat` (via `@mastra/client-js`, used by `sentry init`):
 *   its Zod 3 to JSON Schema converter reads `ZodFirstPartyTypeKind`, and
 *   `isZodV3()` ends with `schema instanceof z3.ZodType`. `sentry init` only
 *   uses the workflow API, which converts no schemas.
 *
 * The stub keeps `ZodType` a class, so that `instanceof` check is `false`
 * instead of a `TypeError`. `ZodFirstPartyTypeKind` throws on access, so a
 * Zod 3 schema that does reach a converter fails with a clear error rather
 * than producing a wrong JSON Schema.
 *
 * Shared by the CLI bundles (`script/bundle.ts`, `script/build.ts`) and the
 * `@sentry/mcp-server` bundle.
 */

import type { Plugin } from "esbuild";

const ZOD_V3_NS = "zod-v3-stub";

const ZOD_V3_STUB = `
export class ZodType {}
export const ZodFirstPartyTypeKind = new Proxy({}, {
  get(_target, key) {
    if (typeof key === "symbol" || key === "then") return undefined;
    throw new Error("Zod 3 schemas are not supported in this build (zod/v3 is not bundled).");
  },
});
export default { ZodType, ZodFirstPartyTypeKind };
`;

export const zodV3StubPlugin: Plugin = {
  name: "zod-v3-stub",
  setup(build) {
    build.onResolve({ filter: /^zod\/v3$/ }, () => ({
      path: "zod/v3",
      namespace: ZOD_V3_NS,
    }));
    build.onLoad({ filter: /.*/, namespace: ZOD_V3_NS }, () => ({
      contents: ZOD_V3_STUB,
      loader: "js",
    }));
  },
};
