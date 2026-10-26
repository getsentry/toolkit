/** Tests for command metadata rendered into generated docs and skills. */

import { lstat, readFile, realpath } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  formatCommandArguments,
  formatCommandExamples,
  formatDestructiveNotice,
} from "../../script/generate-skill-markdown.js";
import { listCommand } from "../../src/commands/agent-conversation/list.js";
import { viewCommand } from "../../src/commands/agent-conversation/view.js";
import { sendCommand } from "../../src/commands/event/send.js";
import { listCommand as feedbackListCommand } from "../../src/commands/feedback/list.js";
import { mergeCommand } from "../../src/commands/issue/merge.js";
import { createCommand } from "../../src/commands/project/create.js";
import { deleteCommand } from "../../src/commands/project/delete.js";
import { listCommand as teamListCommand } from "../../src/commands/team/list.js";
import { listCommand as traceListCommand } from "../../src/commands/trace/list.js";
import { buildCommandInfo } from "../../src/lib/introspect.js";
import {
  ORG_ALL_TARGET_BRIEF,
  PROJECT_TARGET_BRIEF,
} from "../../src/lib/list-command.js";

describe("command metadata in generated references", () => {
  test("derives conversation signatures and examples from command metadata", () => {
    const list = buildCommandInfo(
      listCommand as never,
      "sentry agent-conversation list",
    );
    const view = buildCommandInfo(
      viewCommand as never,
      "sentry agent-conversation view",
    );
    expect(list.positional).toBe("[<org/project>]");
    expect(list.examples).toContain(
      "# Explicit organization (all projects)\nsentry agent-conversation list my-org/",
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
    ).toContain(
      "| `[<org/project>]` | &lt;org&gt;/ (all projects), &lt;org&gt;/&lt;project&gt;, or &lt;project&gt; (search) |",
    );
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
      expect(content).toContain(
        "sentry agent-conversation list [<org/project>]",
      );
      expect(content).toContain(
        "sentry agent-conversation view my-org/conv-123",
      );
      expect(content).not.toContain(
        "sentry agent-conversation view my-org conv-123",
      );
      expect(content).toContain(
        "| `[<org>/]<conversation-id>` | Organization slug (optional) and conversation ID |",
      );
    }
  });

  test("list targets take their syntax from the shared briefs", () => {
    const brief = (cmd: unknown, path: string) =>
      buildCommandInfo(cmd as never, path).positionals[0]?.brief;
    expect(brief(listCommand, "sentry agent-conversation list")).toBe(
      ORG_ALL_TARGET_BRIEF,
    );
    expect(brief(feedbackListCommand, "sentry feedback list")).toBe(
      ORG_ALL_TARGET_BRIEF,
    );
    expect(brief(teamListCommand, "sentry team list")).toBe(
      ORG_ALL_TARGET_BRIEF,
    );
    expect(brief(traceListCommand, "sentry trace list")).toBe(
      PROJECT_TARGET_BRIEF,
    );
  });

  test("flags destructive commands from their metadata", async () => {
    const info = (cmd: unknown, path: string) =>
      buildCommandInfo(cmd as never, path);
    expect(
      formatDestructiveNotice(info(deleteCommand, "sentry project delete")),
    ).toContain("Use `--dry-run` to preview");
    // Marked destructive without a --dry-run flag
    const merge = formatDestructiveNotice(
      info(mergeCommand, "sentry issue merge"),
    );
    expect(merge).toContain("can't easily be undone");
    expect(merge).not.toContain("--dry-run");
    expect(
      formatDestructiveNotice(info(createCommand, "sentry project create")),
    ).toBe("");

    const [docs, skill] = await Promise.all([
      readFile(
        "../../apps/cli-docs/src/content/docs/commands/project.md",
        "utf8",
      ),
      readFile(
        "plugins/sentry-cli/skills/sentry-cli/references/project.md",
        "utf8",
      ),
    ]);
    expect(docs).toContain(":::caution[Destructive]");
    expect(skill).toContain("**Destructive:**");
    // Only the delete section carries the notice
    expect(docs.match(/:::caution\[Destructive\]/g)).toHaveLength(1);
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
