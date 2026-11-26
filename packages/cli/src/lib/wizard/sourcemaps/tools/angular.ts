/**
 * The source map generation step for Angular: shows the `angular.json`
 * setting that turns on source maps and asks the user to check it.
 */

import { clack } from "../../utils/clack/prompts.js";
import chalk from "chalk";
import { abortIfCancelled, makeCodeSnippet } from "../../utils/clack/index.js";

/** The `angular.json` change that turns on source maps. */
const angularJsonTemplate = makeCodeSnippet(true, (unchanged, plus) =>
  unchanged(`{
  "projects": {
    'your-project': {
      "architect": {
        "build": {
          "options": {
            ${plus(`"sourceMap": true`)}
          },
        },
      }
    }
  }
}`),
);

/** Show the `angular.json` change and wait until the user confirms it. */
export async function configureAngularSourcemapGenerationFlow(): Promise<void> {
  clack.log.info(
    `Enable generating source maps in your ${chalk.bold("angular.json")} file:`,
  );

  // Printed outside clack's gutter so that it can be copied/pasted directly
  clack.rawOutput(angularJsonTemplate);

  await abortIfCancelled(
    clack.select({
      message: `Verify that you are generating source maps when building your Angular app.`,
      options: [
        {
          label: "I checked!",
          hint: "My build output folder contains .js.map files after a build.",
          value: true,
        },
      ],
      initialValue: true,
    }),
  );
}
