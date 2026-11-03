/**
 * Preview the real entity pickers with local fixtures, without authentication
 * or project changes. Run `pnpm tsx script/preview-selectors.ts`.
 */
import { selectWithFilter } from "../src/lib/select-ui/ink-ui.js";
import type { SelectOptions } from "../src/lib/select-ui/types.js";

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
  for (const prompt of [organization, team, project]) {
    const value = await selectWithFilter(prompt);
    if (value === null) {
      return;
    }
    chosen.push(value);
  }
  process.stdout.write(`Selected: ${chosen.join(" / ")}\n`);
}

await preview();
