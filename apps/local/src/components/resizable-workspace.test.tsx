import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ResizableWorkspace } from "./resizable-workspace.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

test("keyboard resizing is bounded, persists, and preserves inspector space", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 900,
    left: 0,
  } as DOMRect);
  const { unmount } = render(
    <ResizableWorkspace
      list={<p>Events</p>}
      listLabel="Event list"
      storageKey="test.width"
    >
      <p>Inspector</p>
    </ResizableWorkspace>,
  );
  const separator = screen.getByRole("separator", {
    name: "Resize Event list",
  });
  fireEvent.keyDown(separator, { key: "End" });
  expect(Number(separator.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(
    574,
  );
  expect(Number(localStorage.getItem("test.width"))).toBeLessThanOrEqual(574);
  fireEvent.keyDown(separator, { key: "Home" });
  expect(separator.getAttribute("aria-valuenow")).toBe("256");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator.getAttribute("aria-valuenow")).toBe("272");
  unmount();
  render(
    <ResizableWorkspace
      list={<p>Events</p>}
      listLabel="Event list"
      storageKey="test.width"
    >
      <p>Inspector</p>
    </ResizableWorkspace>,
  );
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
    "272",
  );
});

test("invalid saved widths and unavailable storage leave a usable workspace", () => {
  localStorage.setItem("test.width", "NaN");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(
    <ResizableWorkspace
      list="Events"
      listLabel="Event list"
      storageKey="test.width"
    >
      Inspector
    </ResizableWorkspace>,
  );
  const separator = screen.getByRole("separator");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator.getAttribute("aria-valuenow")).toBe("368");
  expect(screen.getByText("Inspector")).toBeDefined();
});

test("pointer drag resizes the list and cancellation ends the drag", () => {
  const capture = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: capture,
  });
  render(
    <ResizableWorkspace
      list="Events"
      listLabel="Event list"
      storageKey="pointer.width"
    >
      Inspector
    </ResizableWorkspace>,
  );
  const separator = screen.getByRole("separator");
  fireEvent.pointerDown(separator, { button: 0, clientX: 352, pointerId: 1 });
  fireEvent.pointerMove(separator, { clientX: 480, pointerId: 1 });
  expect(separator.getAttribute("aria-valuenow")).toBe("480");
  fireEvent.pointerCancel(separator, { pointerId: 1 });
  fireEvent.pointerMove(separator, { clientX: 600, pointerId: 1 });
  expect(separator.getAttribute("aria-valuenow")).toBe("480");
  expect(localStorage.getItem("pointer.width")).toBe("480");
});
