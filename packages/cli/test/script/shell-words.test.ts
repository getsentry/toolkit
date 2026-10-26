import { describe, expect, test } from "vitest";
import { shellCommands } from "../../script/shell-words.js";

describe("shellCommands", () => {
  test("splits on control operators but not inside quotes", () => {
    expect(
      shellCommands(
        'sentry issue list --query "a|b && c" --json | jq .data; echo done',
      ),
    ).toEqual([
      ["sentry", "issue", "list", "--query", "a|b && c", "--json"],
      ["jq", ".data"],
      ["echo", "done"],
    ]);
  });

  test("keeps angle-bracket doc placeholders as words", () => {
    expect(shellCommands("sentry issue list <org>/<project> --json")).toEqual([
      ["sentry", "issue", "list", "<org>/<project>", "--json"],
    ]);
  });

  test("leaves variables and command substitution unexpanded", () => {
    expect(
      shellCommands(
        'SENTRY_DSN=$DSN sentry release create "$(sentry release propose-version)"',
      ),
    ).toEqual([
      [
        "SENTRY_DSN=$DSN",
        "sentry",
        "release",
        "create",
        "$(sentry release propose-version)",
      ],
    ]);
  });

  test("drops comments and redirections", () => {
    expect(
      shellCommands("sentry issue list --json > issues.json # save"),
    ).toEqual([["sentry", "issue", "list", "--json"]]);
  });

  test("keeps glob patterns literal", () => {
    expect(shellCommands("sentry sourcemap upload ./dist/*.js")).toEqual([
      ["sentry", "sourcemap", "upload", "./dist/*.js"],
    ]);
  });
});
