/**
 * Flag brief conventions across the real route tree.
 *
 * `--help`, the generated command pages, and the skill references all render
 * a value flag's `default` after its brief, so a brief that restates the
 * default ("Port to listen on (default 8969)") shows it twice. Boolean briefs
 * are exempt: they describe what happens without the flag.
 */

import { expect, test } from "vitest";
import { routes } from "../../src/app.js";
import { extractAllRoutes, type RouteMap } from "../../src/lib/introspect.js";

/** "(default 8969)", "(default: ~/)", "(defaults to …)" */
const RESTATED_DEFAULT_RE = /\(defaults?[\s:]/i;

test("flag briefs don't restate a declared default", () => {
  const offenders = extractAllRoutes(routes as unknown as RouteMap)
    .flatMap((route) => route.commands)
    .flatMap((cmd) =>
      cmd.flags
        .filter(
          (flag) =>
            flag.kind !== "boolean" &&
            flag.default !== undefined &&
            RESTATED_DEFAULT_RE.test(flag.brief),
        )
        .map((flag) => `${cmd.path} --${flag.name}: ${flag.brief}`),
    );
  expect(offenders).toEqual([]);
});
