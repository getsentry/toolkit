import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createLocalTelemetryStore } from "../lib/telemetry-store.ts";
import { workspacePath } from "../lib/workspace.ts";
import {
  WorkspaceSidebar,
  type WorkspaceSidebarProps,
} from "./workspace-sidebar.tsx";

afterEach(cleanup);
function sidebarProps(): WorkspaceSidebarProps {
  return {
    activeView: "live",
    canSearch: true,
    collapsed: false,
    connection: { label: "Connected to local receiver", tone: "success" },
    retainedItemCount: 0,
    snapshot: createLocalTelemetryStore().getSnapshot(),
    traceCount: 0,
    onClear: vi.fn(),
    onDisconnect: vi.fn(),
    isClearing: false,
    onChangeReceiver: vi.fn(),
    isClosingSession: false,
    onOpenSettings: vi.fn(),
    onOpenCommand: vi.fn(),
    onSelect: vi.fn(),
    onToggle: vi.fn(),
  };
}

test("keeps core views prominent and reveals diagnostics without changing compatible routes", () => {
  const props = sidebarProps();
  render(<WorkspaceSidebar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Open events view" }));
  expect(props.onSelect).toHaveBeenCalledWith("live");
  expect(workspacePath("live")).toBe("/live");
  expect(
    screen.queryByRole("button", { name: "Open sdk reports view" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open sdk reports view" }),
  );
  expect(props.onSelect).toHaveBeenCalledWith("sdks");
  expect(workspacePath("sdks")).toBe("/sdks");
});

test("opens diagnostics for the selected route and lets users collapse it", () => {
  render(<WorkspaceSidebar {...sidebarProps()} activeView="envelopes" />);
  expect(
    screen
      .getByRole("button", { name: "Open envelopes view" })
      .getAttribute("aria-current"),
  ).toBe("page");
  const diagnostics = screen.getByRole("button", { name: "Diagnostics" });
  expect(diagnostics.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(diagnostics);
  expect(
    screen.queryByRole("button", { name: "Open envelopes view" }),
  ).toBeNull();
});

test("labels session-wide search and hands its persistent trigger to the command dialog", () => {
  const props = sidebarProps();
  render(<WorkspaceSidebar {...props} />);
  const search = screen.getByRole("button", { name: "Search this session" });
  expect(search.textContent).toContain("Search this session");
  fireEvent.click(search);
  expect(props.onOpenCommand).toHaveBeenCalledWith(search);
  expect(screen.queryByRole("status")).toBeNull();
});

test("shares capture actions and capability-gated deletion with the mobile control", async () => {
  const props = sidebarProps();
  const remove = vi.fn();
  const { rerender } = render(<WorkspaceSidebar {...props} />);
  const trigger = screen.getByRole("button", { name: "Capture actions" });
  const switchReceiver = screen.getByRole("button", {
    name: "Switch receiver",
  });
  fireEvent.click(switchReceiver);
  expect(props.onChangeReceiver).toHaveBeenCalledWith(switchReceiver);
  const settings = screen.getByRole("button", {
    name: "Settings",
    exact: true,
  });
  fireEvent.click(settings);
  expect(props.onOpenSettings).toHaveBeenCalledWith(settings);
  fireEvent.click(trigger);
  expect(
    screen.queryByRole("button", { name: "Delete captured events" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Clear view" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Capture actions" }), {
    key: "Escape",
  });
  rerender(<WorkspaceSidebar {...props} onDeleteCapturedEvents={remove} />);
  fireEvent.click(trigger);
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete captured events" }),
  );
  expect(remove).toHaveBeenCalledWith(trigger);
});

test("keeps search and actions keyboard named when the sidebar is collapsed", () => {
  const props = sidebarProps();
  render(<WorkspaceSidebar {...props} collapsed />);
  expect(
    screen.getByRole("button", { name: "Search this session" }),
  ).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "Capture actions" }),
  ).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(props.onToggle).toHaveBeenCalledOnce();
});
