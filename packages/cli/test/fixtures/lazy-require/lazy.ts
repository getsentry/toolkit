/** Requires `target.ts` lazily, the way `db/resilient.ts` requires `db/index.ts`. */
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

export function requireTarget(): typeof import("./target.js") {
  return _require("./target.js") as typeof import("./target.js");
}

/** Long enough that the formatter wraps the call, as in `formatters/json.ts`. */
export function requireTargetDescriber(): () => string {
  const { describeTarget: describeLazilyRequiredTarget } = _require(
    "./target.js",
  ) as typeof import("./target.js");
  return describeLazilyRequiredTarget;
}
