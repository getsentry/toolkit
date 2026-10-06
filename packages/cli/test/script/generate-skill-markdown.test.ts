/** Tests for generated command-heading and example association parsing. */

import { lstat, readFile, realpath } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  extractCommandPathFromHeading,
  formatCommandArguments,
  formatCommandExamples,
  matchExampleToCommand,
} from "../../script/generate-skill-markdown.js";
import { listCommand } from "../../src/commands/agent-conversation/list.js";
import { viewCommand } from "../../src/commands/agent-conversation/view.js";
import { sendCommand } from "../../src/commands/event/send.js";
import { mergeCommand } from "../../src/commands/issue/merge.js";
import { createCommand } from "../../src/commands/project/create.js";
import { buildCommandInfo } from "../../src/lib/introspect.js";

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
  test("derives conversation signatures and examples from command metadata", () => {
    const list = buildCommandInfo(
      listCommand as never,
      "sentry agent-conversation list",
    );
    const view = buildCommandInfo(
      viewCommand as never,
      "sentry agent-conversation view",
    );
    expect(list.positional).toBe("[<org>]");
    expect(list.examples).toContain(
      "# Explicit organization\nsentry agent-conversation list my-org",
    );
    expect(view.positional).toBe("[<org>/]<conversation-id>");
    expect(view.examples).toContain(
      "# Explicit organization\nsentry agent-conversation view my-org/conv-123",
    );
    expect(formatCommandExamples(view.examples)).toContain(
      "sentry agent-conversation view conv-123",
    );
  });

  test("preserves tuple, variadic, and compound argument syntax", () => {
    const info = (cmd: unknown, path: string) =>
      buildCommandInfo(cmd as never, path).positionals;
    expect(
      formatCommandArguments(
        info(listCommand, "sentry agent-conversation list"),
      ),
    ).toContain("| `[<org>]` | Organization slug |");
    expect(
      formatCommandArguments(
        info(viewCommand, "sentry agent-conversation view"),
      ),
    ).toContain(
      "| `[<org>/]<conversation-id>` | Organization slug (optional) and conversation ID |",
    );
    expect(
      formatCommandArguments(info(sendCommand, "sentry event send")),
    ).toContain(
      "| `<target-or-file...>` | Optional DSN/project target followed by JSON event file path(s) |",
    );
    expect(
      formatCommandArguments(info(mergeCommand, "sentry issue merge")),
    ).toContain("| `<issue...>` | Issue IDs to merge (2 or more required) |");
    expect(
      formatCommandArguments(info(createCommand, "sentry project create")),
    ).toContain("| `[<org>/]<name>:<platform>...` |");
  });

  test("generates matching command docs and skill references", async () => {
    const [docs, skill] = await Promise.all([
      readFile(
        "../../apps/cli-docs/src/content/docs/commands/agent-conversation.md",
        "utf8",
      ),
      readFile(
        "plugins/sentry-cli/skills/sentry-cli/references/agent-conversation.md",
        "utf8",
      ),
    ]);
    for (const content of [docs, skill]) {
      expect(content).toContain(
        "sentry agent-conversation view [<org>/]<conversation-id>",
      );
      expect(content).toContain("sentry agent-conversation list [<org>]");
      expect(content).toContain(
        "sentry agent-conversation view my-org/conv-123",
      );
      expect(content).not.toContain(
        "sentry agent-conversation view my-org conv-123",
      );
    }
    expect(docs).toContain(
      "| `[<org>/]<conversation-id>` | Organization slug (optional) and conversation ID |",
    );
  });

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
