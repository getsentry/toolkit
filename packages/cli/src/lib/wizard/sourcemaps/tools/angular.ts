/**
 * Source map generation step for Angular: ask the user to turn on
 * `sourceMap` in `angular.json`.
 */

import chalk from "chalk";
import { abortIfCancelled, makeCodeSnippet } from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";

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

/** Show the `angular.json` change and wait until the user made it. */
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
