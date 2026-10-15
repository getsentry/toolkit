import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useRef, useState } from "react";
import { ReceiverControls } from "./receiver-controls.tsx";
import { LocalSettings } from "./local-settings.tsx";
import { ThemeProvider } from "./theme-provider.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const connection = {
  label: "Connected to local receiver",
  tone: "success",
} as const;

test("mobile receiver actions dismiss with Escape and restore keyboard focus", async () => {
  render(
    <ReceiverControls
      connection={connection}
      retainedItemCount={2}
      onClear={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Receiver options" });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", {
    name: "Receiver actions",
  });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("mobile Settings opens the shared modal without its closing popover stealing focus", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  function ViewerActions() {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLButtonElement | null>(null);
    return (
      <ThemeProvider attribute="class" defaultTheme="light">
        <ReceiverControls
          connection={connection}
          retainedItemCount={2}
          onClear={vi.fn()}
          onOpenSettings={(trigger) => {
            ref.current = trigger;
            setOpen(true);
          }}
        />
        <LocalSettings
          triggerRef={ref}
          open={open}
          onOpenChange={setOpen}
          supported={false}
          editable={false}
          limit={500}
          count={2}
          streamUrl="http://127.0.0.1:8969/stream"
        />
      </ThemeProvider>
    );
  }
  render(<ViewerActions />);
  const trigger = screen.getByRole("button", { name: "Receiver options" });
  fireEvent.click(trigger);
  fireEvent.click(
    await screen.findByRole("button", { name: "Settings", exact: true }),
  );
  await screen.findByRole("dialog", { name: "Settings", exact: true });
  expect(screen.queryByRole("dialog", { name: "Receiver actions" })).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Light", exact: true }),
    ),
  );
  expect(screen.queryByRole("button", { name: /Use .* mode/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("mobile actions prevent empty clears and duplicate close requests", async () => {
  const clear = vi.fn();
  const close = vi.fn();
  const add = vi.fn();
  render(
    <ReceiverControls
      connection={connection}
      retainedItemCount={0}
      onClear={clear}
      onCloseSession={close}
      isClosingSession
      onAddReceiver={add}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Receiver options" });
  fireEvent.click(trigger);
  const clearButton = await screen.findByRole("button", {
    name: "Clear all events",
  });
  const closeButton = screen.getByRole("button", { name: "Close session" });
  expect((clearButton as HTMLButtonElement).disabled).toBe(true);
  expect((closeButton as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(clearButton);
  fireEvent.click(closeButton);
  expect(clear).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Add receiver", exact: true }),
  );
  expect(add).toHaveBeenCalledWith(trigger);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
