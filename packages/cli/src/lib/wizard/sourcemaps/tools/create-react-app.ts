/**
 * Source map generation step for Create React App, which generates source
 * maps unless `GENERATE_SOURCEMAP` is off.
 */

import { abortIfCancelled } from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";

/** Ask the user to confirm that the CRA build generates source maps. */
export async function configureCRASourcemapGenerationFlow(): Promise<void> {
  await abortIfCancelled(
    clack.select({
      message: `Verify that you are generating source maps when building your React app.\nGenerally this should already happen unless you set the GENERATE_SOURCEMAPS environment variable to false.`,
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
