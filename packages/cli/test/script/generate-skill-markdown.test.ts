/** Tests for generated command-heading and example association parsing. */

import { lstat, readFile, realpath } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  extractCommandPathFromHeading,
  matchExampleToCommand,
} from "../../script/generate-skill-markdown.js";

describe("extractCommandPathFromHeading", () => {
  test.each([
    ["`sentry issue view <issue-id>`", "sentry issue view"],
    ["`sentry issue view <issue...>`", "sentry issue view"],
    [
      "`sentry project create [<org>/]<name>:<platform>...`",
      "sentry project create",
    ],
    ["`sentry auth status`", "sentry auth status"],
  ])("extracts the command path from %s", (heading, expected) => {
    expect(extractCommandPathFromHeading(heading)).toBe(expected);
  });

  test("ignores descriptive headings", () => {
    expect(extractCommandPathFromHeading("Create a project")).toBeUndefined();
  });
});

describe("matchExampleToCommand", () => {
  test("associates a project create block with its command", () => {
    const code = [
      "# Create projects",
      "sentry project create web:javascript api:python-django",
    ].join("\n");

    expect(
      matchExampleToCommand(
        code,
        ["sentry project create", "sentry project delete"],
        "sentry project",
      ),
    ).toBe("sentry project create");
  });

  test("maps bare group examples to the default subcommand", () => {
    expect(
      matchExampleToCommand(
        "sentry auth\nsentry auth --token YOUR_SENTRY_API_TOKEN",
        ["sentry auth login", "sentry auth logout", "sentry auth status"],
        "sentry auth",
        "sentry auth login",
      ),
    ).toBe("sentry auth login");
  });

  test("prefers longer command paths over shorter prefixes", () => {
    expect(
      matchExampleToCommand(
        "sentry auth login --token TOKEN",
        ["sentry auth login", "sentry auth status"],
        "sentry auth",
        "sentry auth login",
      ),
    ).toBe("sentry auth login");
  });

  test("the generated project reference retains create examples", async () => {
    const reference = await readFile(
      "plugins/sentry-cli/skills/sentry-cli/references/project.md",
      "utf8",
    );

    expect(reference).toContain(
      "### `sentry project create [<org>/]<name>:<platform>...`",
    );
    expect(reference).not.toContain('sentry project create "My New App":');
    // The platform must always be attached with ":" — no space-separated form.
    expect(reference).not.toContain(
      "sentry project create my-new-app javascript-nextjs",
    );
    expect(reference).not.toContain(
      "sentry project create my-org/my-new-app javascript-nextjs",
    );
    expect(reference).toContain(
      "sentry project create web:javascript api:python-django worker:node",
    );
    expect(reference).toContain(
      "sentry project create my-new-app:javascript-nextjs",
    );
  });
});

test("published skill matches the plugin and links to its references", async () => {
  const plugin = "plugins/sentry-cli/skills/sentry-cli";
  const published = "../../apps/cli-docs/public/.well-known/skills/sentry-cli";

  expect(await readFile(`${published}/SKILL.md`)).toEqual(
    await readFile(`${plugin}/SKILL.md`),
  );
  expect((await lstat(`${published}/references`)).isSymbolicLink()).toBe(true);
  expect(await realpath(`${published}/references`)).toBe(
    await realpath(`${plugin}/references`),
  );
});
