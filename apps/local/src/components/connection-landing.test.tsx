import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ConnectionLanding } from "./connection-landing.tsx";
import { ReceiverDialog } from "./receiver-dialog.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const form = {
  endpoint: "http://localhost:8969/stream",
  isConnecting: false,
  onConnect: vi.fn(),
  onEndpointChange: vi.fn(),
  recentConnections: [],
  onReconnect: vi.fn(),
  onForget: vi.fn(),
};
test("first run copies a capture command and keeps existing receiver entry secondary", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<ConnectionLanding {...form} phase="editing" />);
  expect(
    screen.getByRole("heading", { name: "Capture a local session" }),
  ).not.toBeNull();
  expect(screen.getByText(/Replace <your dev command>/)).not.toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Copy local run command" }),
  );
  expect(writeText).toHaveBeenCalledWith(
    "sentry local run --session web --open -- <your dev command>",
  );
  const existing = screen.getByText("Connect an existing receiver");
  fireEvent.click(existing);
  fireEvent.submit(
    screen
      .getByRole("button", { name: "Connect", exact: true })
      .closest("form")!,
  );
  expect(form.onConnect).toHaveBeenCalledOnce();
});

test("switching receivers preserves the current feed and does not show onboarding", () => {
  render(
    <ReceiverDialog
      {...form}
      open
      onOpenChange={vi.fn()}
      triggerRef={{ current: null }}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Switch receiver" }),
  ).not.toBeNull();
  expect(screen.getByText(/current feed stays open/)).not.toBeNull();
  expect(
    screen.queryByRole("button", { name: "Copy local run command" }),
  ).toBeNull();
});
