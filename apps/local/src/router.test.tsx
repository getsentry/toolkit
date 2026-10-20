import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LocalRouter } from "./router.tsx";

class OpeningEventSource extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(_url: string) {
    super();
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  close() {}
}

describe("LocalRouter", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("EventSource", OpeningEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders the compatible root route", async () => {
    render(<LocalRouter />);

    expect(
      (
        await screen.findByRole("button", { name: "Open live activity view" })
      ).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByRole("banner")).toBeNull();
  });
});
