import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CaptureHeader } from "./capture-header.tsx";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T10:00:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const streamUrl =
  "http://127.0.0.1:8969/_local/v1/sessions/web/stream?cap=SECRET";
const session = {
  id: "web",
  label: "Web app",
  cwd: "/projects/web",
  state: "open" as const,
  streamUrl,
};
const props = {
  streamUrl,
  connection: "connected" as const,
  isClosed: false,
  session,
  onReload: vi.fn(),
  isReloading: false,
};

test("unifies capture identity with receiver connectivity and the last received time", () => {
  render(<CaptureHeader {...props} latestEventTime={1793010600000} />);
  expect(screen.getByRole("heading", { name: "Web app" })).not.toBeNull();
  expect(screen.getByText("/projects/web")).not.toBeNull();
  expect(screen.getByText("Capturing")).not.toBeNull();
  expect(screen.getByText("Connected to local receiver")).not.toBeNull();
  expect(screen.getByText(/Last received/)).not.toBeNull();
  expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-10-26T10:30:00.000Z",
  );
  expect(document.body.innerHTML).not.toContain("SECRET");
  const address = screen.getByText("http://127.0.0.1:8969");
  expect(address.getAttribute("title")).toBe("http://127.0.0.1:8969");
  expect(document.body.innerHTML).not.toContain("/_local/v1/sessions/");
  fireEvent.click(screen.getByRole("button", { name: "Reload capture" }));
  expect(props.onReload).toHaveBeenCalledOnce();
});

test("shows a saved capture independently of a failed receiver and preserves the actual deadline", () => {
  render(
    <CaptureHeader
      {...props}
      isClosed
      connection="failed"
      expiresAt={1793010600000}
    />,
  );
  expect(screen.getByText("Saved capture")).not.toBeNull();
  expect(screen.getByText("Receiver unavailable")).not.toBeNull();
  expect(screen.getByText(/Saved until/)).not.toBeNull();
  expect(screen.getByRole("button", { name: "Reconnect" })).not.toBeNull();
});

test("does not invent expiry or repeat the picker identity", () => {
  render(
    <CaptureHeader
      {...props}
      isClosed
      sessionPicker={<button type="button">Web app picker</button>}
    />,
  );
  expect(screen.getByRole("button", { name: "Web app picker" })).not.toBeNull();
  expect(screen.queryByRole("heading", { name: "Web app" })).toBeNull();
  expect(screen.queryByText(/Saved until/)).toBeNull();
});

test("awaiting a daemon session asks for capture selection without implying capture is active", () => {
  render(
    <CaptureHeader
      {...props}
      streamUrl="http://127.0.0.1:8969/stream"
      session={undefined}
      isAwaitingSession
    />,
  );
  expect(screen.getByText("Choose a capture")).not.toBeNull();
  expect(screen.queryByText("Capturing")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reload capture" })).toBeNull();
});

test("never displays stale capture identity or URL credentials after changing receiver", () => {
  render(
    <CaptureHeader
      {...props}
      streamUrl="https://receiver.example/stream?token=HIDDEN"
      connection="failed"
    />,
  );
  expect(screen.queryByText("Web app")).toBeNull();
  expect(screen.queryByText("/projects/web")).toBeNull();
  expect(document.body.textContent).not.toMatch(/SECRET|HIDDEN|token=|cap=/);
  expect(screen.getByText("Connection lost")).not.toBeNull();
  expect(screen.getByText("https://receiver.example")).not.toBeNull();
});

test("shows reconnecting state and prevents duplicate reload requests", () => {
  const onReload = vi.fn();
  render(
    <CaptureHeader
      {...props}
      connection="reconnecting"
      isReloading
      onReload={onReload}
    />,
  );
  expect(screen.getByText("Connecting")).not.toBeNull();
  const reload = screen.getByRole("button", { name: "Reload capture" });
  expect(reload.hasAttribute("disabled")).toBe(true);
  expect(reload.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(reload);
  expect(onReload).not.toHaveBeenCalled();
});

test("expires at the frozen save deadline despite newer events and preserves capture identity", async () => {
  const onReload = vi.fn();
  const expiresAt = Date.now() + 2000;
  const { rerender } = render(
    <CaptureHeader
      {...props}
      isClosed
      expiresAt={expiresAt}
      onReload={onReload}
    />,
  );
  expect(screen.getByText("Saved capture")).not.toBeNull();
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTime(1000));
  rerender(
    <CaptureHeader
      {...props}
      isClosed
      expiresAt={expiresAt}
      latestEventTime={Date.now()}
      onReload={onReload}
    />,
  );
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("Saved capture expired")).not.toBeNull();
  expect(screen.getByRole("heading", { name: "Web app" })).not.toBeNull();
  expect(
    screen.getByText("Events already loaded in this tab remain available."),
  ).not.toBeNull();
  const reload = screen.getByRole("button", { name: "Reload capture" });
  expect(reload.hasAttribute("disabled")).toBe(true);
  fireEvent.click(reload);
  expect(onReload).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("never infers or carries forward expiry for an older receiver omitting metadata", async () => {
  const { rerender } = render(
    <CaptureHeader {...props} isClosed expiresAt={Date.now() - 1} />,
  );
  expect(screen.getByText("Saved capture expired")).not.toBeNull();
  rerender(
    <CaptureHeader
      {...props}
      streamUrl="http://127.0.0.1:8970/stream"
      session={undefined}
      isClosed
    />,
  );
  expect(screen.getByText("Saved capture")).not.toBeNull();
  expect(screen.queryByText(/Saved until/)).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Reload capture" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000));
  expect(screen.getByText("Saved capture")).not.toBeNull();
});

test("caps expiry timer delays and cleans up the single pending timer on unmount", async () => {
  const maxTimeout = 2_147_483_647;
  const expiresAt = Date.now() + maxTimeout + 1000;
  const { rerender, unmount } = render(
    <CaptureHeader {...props} isClosed expiresAt={expiresAt} />,
  );
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTime(maxTimeout));
  expect(screen.getByText("Saved capture")).not.toBeNull();
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("Saved capture expired")).not.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  rerender(<CaptureHeader {...props} isClosed expiresAt={Date.now() + 1000} />);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("keeps the single reload action with connectivity metadata so capture identity has full width", () => {
  render(<CaptureHeader {...props} latestEventTime={1793010600000} />);
  const metadataRow = screen.getByText(
    "Connected to local receiver",
  ).parentElement;
  const reload = screen.getByRole("button", { name: "Reload capture" });
  expect(metadataRow?.contains(reload)).toBe(true);
  expect(metadataRow?.textContent).toContain("Last received");
  expect(
    screen.getAllByRole("button", { name: "Reload capture" }),
  ).toHaveLength(1);
});
