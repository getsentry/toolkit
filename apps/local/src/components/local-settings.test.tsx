import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LocalSettings } from "./local-settings.tsx";

afterEach(cleanup);
const props = {
  open: true,
  onOpenChange: vi.fn(),
  triggerRef: { current: null },
  streamUrl: "http://127.0.0.1:8969/stream",
  limit: 500,
  count: 8,
  editable: false,
  supported: true,
  captureLabel: "Web app",
};

test("separates global appearance, capture capacity, and the existing save deadline", () => {
  const expiresAt = 1793010600000;
  render(<LocalSettings {...props} expiresAt={expiresAt} />);
  expect(screen.getByRole("heading", { name: "Appearance" })).not.toBeNull();
  expect(screen.getByText(/Applies to all captures/)).not.toBeNull();
  expect(
    screen.getByRole("heading", { name: "History capacity" }),
  ).not.toBeNull();
  expect(screen.getByText("For capture: Web app")).not.toBeNull();
  expect(
    screen.getByText(/An SDK envelope can contain several events/),
  ).not.toBeNull();
  expect(screen.getByText("Saved until")).not.toBeNull();
  expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-10-26T10:30:00.000Z",
  );
  expect(screen.queryByRole("spinbutton")).toBeNull();
});

test.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
  "does not invent a saved deadline from %s",
  (expiresAt) => {
    render(<LocalSettings {...props} expiresAt={expiresAt} />);
    expect(screen.queryByText("Saved until")).toBeNull();
  },
);
