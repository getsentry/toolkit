import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { highlight } = vi.hoisted(() => ({
  highlight: vi.fn<(code: string) => string | Promise<string>>(),
}));
vi.mock("@shikijs/core", () => ({
  createHighlighterCore: () => Promise.resolve({ codeToHtml: highlight }),
}));
import { JsonView } from "./json-view.tsx";

beforeEach(() => highlight.mockReset());
afterEach(() => cleanup());
describe("JsonView updates", () => {
  test.each(["pending", "failed"])(
    "shows current source when replacement highlighting is %s",
    async (mode) => {
      highlight.mockReturnValueOnce("<pre>first envelope</pre>");
      let finish: ((html: string) => void) | undefined;
      if (mode === "pending") {
        highlight.mockReturnValueOnce(
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
        );
      } else {
        highlight.mockImplementationOnce(() => {
          throw new Error("highlight failed");
        });
      }
      const view = render(<JsonView code={'{"event":"first"}'} />);
      await waitFor(() =>
        expect(screen.getByTestId("highlighted-json").textContent).toBe(
          "first envelope",
        ),
      );
      view.rerender(<JsonView code={'{"event":"second"}'} />);
      expect(screen.getByTestId("highlighted-json").textContent).toContain(
        '"second"',
      );
      expect(screen.getByTestId("highlighted-json").textContent).not.toContain(
        "first envelope",
      );
      if (finish) {
        finish("<pre>second envelope</pre>");
        await waitFor(() =>
          expect(screen.getByTestId("highlighted-json").textContent).toBe(
            "second envelope",
          ),
        );
      } else {
        await waitFor(() => expect(highlight).toHaveBeenCalledTimes(2));
        expect(screen.getByTestId("highlighted-json").textContent).toContain(
          '"second"',
        );
      }
    },
  );
});
