/** Keep Sentry SDK dependencies out of the completion startup path. */

import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

const ANY_IMPORT = /.*/;

test.each(["cli.ts", "index.ts"])(
  "%s does not eagerly import the Sentry SDK",
  async (entry) => {
    await expect(
      build({
        entryPoints: [join(import.meta.dirname, "../../src", entry)],
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        logLevel: "silent",
        plugins: [
          {
            name: "check-startup-imports",
            setup(builder) {
              builder.onResolve({ filter: ANY_IMPORT }, (args) => {
                // Deferred imports do not execute when an entry point loads.
                if (args.kind === "dynamic-import") {
                  return { path: args.path, external: true };
                }
                // Hostname and origin predicates are pure and have no startup
                // side effects. Traverse their source to catch future SDK imports.
                if (
                  args.path.startsWith("@sentry/") &&
                  args.path !== "@sentry/toolkit-core/sentry-host" &&
                  args.path !== "@sentry/toolkit-core/sentry-origin"
                ) {
                  return {
                    errors: [
                      {
                        text: `Eager SDK dependency ${args.path} from ${args.importer}`,
                      },
                    ],
                  };
                }
                return;
              });
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ errors: [] });
  },
);
