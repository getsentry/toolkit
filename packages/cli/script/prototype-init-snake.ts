/**
 * Prototype harness: drives the real `sentry init` Ink UI through a fake,
 * offline workflow so the waiting-screen Snake game can be tried locally.
 * No network calls, no auth, no file changes.
 *
 *   pnpm --filter sentry run proto:snake
 *   PROTO_STEP_MS=5000 pnpm --filter sentry run proto:snake
 */

import { setTimeout as sleep } from "node:timers/promises";
import { createInkUI } from "../src/lib/init/ui/ink-ui.js";

const STEP_MS = Number(process.env.PROTO_STEP_MS ?? 20_000);

const STEPS: Array<{ id: string; message: string; files?: string[] }> = [
  {
    id: "discover-context",
    message: "Reading project files...",
    files: ["package.json", "src/index.ts", "src/server.ts", "tsconfig.json"],
  },
  { id: "detect-platform", message: "Detecting platform..." },
  { id: "ensure-sentry-project", message: "Creating Sentry project..." },
  { id: "plan-codemods", message: "Planning SDK setup..." },
  { id: "apply-codemods", message: "Applying changes..." },
  { id: "verify-changes", message: "Verifying setup..." },
];

const ui = await createInkUI();
ui.setIntroMode?.(false);
const spin = ui.spinner();

for (const [index, step] of STEPS.entries()) {
  ui.setStep?.(step.id, "in_progress");
  spin.start(step.message);
  if (step.files) {
    ui.recordFilesReading?.(step.files);
  }
  await sleep(STEP_MS);
  spin.stop(`${step.message.replace("...", "")} done`, 0);
  ui.setStep?.(step.id, "completed");

  // Mid-run prompt checks that the game yields the pane and keys.
  if (index === 1) {
    const answer = await ui.confirm({
      message: "Prototype prompt: does the game get out of the way?",
      initialValue: true,
    });
    ui.log.info(`Prompt answered: ${String(answer)}`);
  }
}

ui.outro("Prototype finished. Press any key to exit.");
await ui[Symbol.asyncDispose]();
