import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SessionSwitcher } from "./session-switcher.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const directoryUrl = "http://127.0.0.1:8969/_local/v1/ui/sessions?cap=test";
const active = {
  id: "web",
  label: "Web app",
  cwd: "/projects/web",
  state: "open",
  streamUrl: "http://127.0.0.1:8969/_local/v1/sessions/web/stream?cap=web",
};
const saved = {
  id: "old",
  label: "Previous run",
  cwd: "/projects/web",
  state: "retained",
  streamUrl: "http://127.0.0.1:8969/_local/v1/sessions/old/stream?cap=old",
};

test("reports the current capture metadata and clears it for an unknown stream", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ sessions: [active, saved] })),
      ),
  );
  const onCurrentSessionChange = vi.fn();
  const props = {
    directoryUrl,
    streamUrl: active.streamUrl,
    onSelect: vi.fn(),
    onCurrentSessionChange,
  };
  const { rerender } = render(<SessionSwitcher {...props} />);
  await waitFor(() =>
    expect(onCurrentSessionChange).toHaveBeenLastCalledWith(active),
  );
  expect(screen.getByText("Capturing")).not.toBeNull();
  rerender(
    <SessionSwitcher {...props} streamUrl="http://127.0.0.1:8969/stream" />,
  );
  await waitFor(() =>
    expect(onCurrentSessionChange).toHaveBeenLastCalledWith(undefined),
  );
});

test("hides duplicate header state while retaining capturing and saved choices", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ sessions: [active, saved] })),
      ),
  );
  const onSelect = vi.fn();
  render(
    <SessionSwitcher
      directoryUrl={directoryUrl}
      streamUrl={active.streamUrl}
      onSelect={onSelect}
      showState={false}
    />,
  );
  await screen.findByText("Web app");
  expect(screen.queryByText("Capturing")).toBeNull();
  fireEvent.click(screen.getByRole("combobox", { name: "Session" }));
  const option = await screen.findByRole("option", {
    name: /Previous run · Saved/,
  });
  expect(
    screen.getByRole("option", { name: /Web app · Capturing/ }),
  ).not.toBeNull();
  fireEvent.click(option);
  expect(onSelect).toHaveBeenCalledWith(saved.streamUrl);
});
