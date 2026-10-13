/**
 * Preview the real entity pickers with local fixtures, without authentication
 * or project changes. Run `pnpm tsx script/preview-selectors.ts`; add `--compact`
 * for the Org/Project picker used outside the init wizard.
 */
import { createInkUI, selectWithFilter } from "../src/lib/init/ui/ink-ui.js";
import { isCancelled, type SelectOptions } from "../src/lib/init/ui/types.js";

const organization: SelectOptions<string> = {
  message: "Which organization should the project be created in?",
  filterable: true,
  options: [
    { value: "acme", label: "Acme", hint: "acme" },
    { value: "frontend-labs", label: "Frontend Labs", hint: "frontend-labs" },
    { value: "sandbox", label: "Sandbox", hint: "sandbox" },
  ],
};
const team: SelectOptions<string> = {
  message: "Which team should own this project?",
  filterable: true,
  options: [
    { value: "backend", label: "backend", hint: "Backend Engineering" },
    { value: "frontend", label: "frontend", hint: "Web Engineering" },
    { value: "mobile", label: "mobile", hint: "Mobile Engineering" },
    { value: "platform", label: "platform", hint: "Developer Platform" },
  ],
};
const project: SelectOptions<string> = {
  message: "Select a project:",
  filterable: true,
  options: [
    "api-gateway",
    "backend-workers",
    "frontend-admin",
    "frontend-web",
    "mobile-ios",
    "payments-api",
    "storefront-api",
  ].map((value) => ({ value, label: value })),
};

async function preview(): Promise<void> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error("Run this preview in an interactive terminal.");
  }
  const chosen: string[] = [];
  if (process.argv.includes("--compact")) {
    for (const prompt of [organization, project]) {
      const value = await selectWithFilter(prompt);
      if (value === null) {
        return;
      }
      chosen.push(value);
    }
  } else {
    await using ui = await createInkUI();
    ui.setIntroMode(true);
    for (const prompt of [
      organization,
      team,
      { ...project, message: "Which app would you like to configure?" },
    ]) {
      const value = await ui.select(prompt);
      if (isCancelled(value)) {
        return;
      }
      chosen.push(value);
    }
    ui.outro("Selector preview complete");
  }
  process.stdout.write(`Selected: ${chosen.join(" / ")}\n`);
}

await preview();
