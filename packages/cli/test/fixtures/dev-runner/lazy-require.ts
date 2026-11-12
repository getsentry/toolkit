/**
 * Loads a source module with `import`, then with the lazy relative `require`
 * pattern `src/lib/db/resilient.ts` and `src/lib/db/index.ts` use, and prints
 * whether both return the same module instance.
 */

import { createRequire } from "node:module";
import { getDbPath } from "../../../src/lib/db/index.js";

const required = createRequire(import.meta.url)(
  "../../../src/lib/db/index.js",
) as { getDbPath: typeof getDbPath };

process.stdout.write(required.getDbPath === getDbPath ? "same" : "different");
