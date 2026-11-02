/** Unit tests for the CLI's `@clack/prompts` wrapper. */

import { describe, expect, test, vi } from "vitest";
import { prompt } from "../../src/lib/prompt.js";

const clack = vi.hoisted(() => ({
  confirm: vi.fn(),
  text: vi.fn(),
}));

vi.mock("@clack/prompts", () => clack);

describe("prompt", () => {
  test("returns clack's cancel symbol instead of the initial value on Ctrl+C", async () => {
    const cancel = Symbol("clack:cancel");
    clack.confirm.mockResolvedValue(cancel);

    const answer = await prompt("Import from .sentryclirc?", {
      type: "confirm",
      initial: true,
    });

    expect(clack.confirm).toHaveBeenCalledWith({
      message: "Import from .sentryclirc?",
      initialValue: true,
    });
    expect(answer).toBe(cancel);
  });

  test("passes text prompt options through to clack", async () => {
    clack.text.mockResolvedValue("my-project");

    const answer = await prompt("Type the project slug:", {
      type: "text",
      placeholder: "slug",
    });

    expect(clack.text).toHaveBeenCalledWith({
      message: "Type the project slug:",
      placeholder: "slug",
      initialValue: undefined,
      defaultValue: undefined,
    });
    expect(answer).toBe("my-project");
  });
});
