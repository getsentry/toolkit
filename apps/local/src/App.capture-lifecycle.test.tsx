import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { BrowserRouter } from "react-router";
import { ThemeProvider } from "./components/theme-provider.tsx";
import { LocalWorkspaceRoute } from "./routes/local-workspace-route.tsx";
import App from "./App.tsx";
import {
  REMOTE_STREAM_STORAGE_KEY,
  STREAM_STORAGE_KEY,
} from "./lib/spotlight.ts";

const STREAM =
  "http://127.0.0.1:8969/_local/v1/sessions/web/stream?cap=web-read";
const WORKER_STREAM =
  "http://127.0.0.1:8969/_local/v1/sessions/worker/stream?cap=worker-read";
const DIRECTORY =
  "http://127.0.0.1:8969/_local/v1/ui/sessions?cap=directory-read";
const EXPIRES_AT = 1_795_000_000_000;
const REMOTE_STREAM = "https://receiver.example/stream?token=remote-read";

class ControllableEventSource extends EventTarget {
  static instances: ControllableEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    super();
    ControllableEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function renderCapture({ path = "/live", directory = false } = {}) {
  window.history.replaceState(
    null,
    "",
    `${path}#${new URLSearchParams({ stream: STREAM, ...(directory ? { directory: DIRECTORY } : {}) })}`,
  );
  return renderViewer();
}

function renderViewer() {
  return render(
    <ThemeProvider attribute="class" defaultTheme="light">
      <NuqsAdapter>
        <BrowserRouter>
          <LocalWorkspaceRoute>
            <App />
          </LocalWorkspaceRoute>
        </BrowserRouter>
      </NuqsAdapter>
    </ThemeProvider>,
  );
}

async function openLatestReceiver() {
  const probe = await openSource();
  const committed = ControllableEventSource.instances.at(-1)!;
  return committed === probe ? committed : await openSource(committed);
}

async function switchReceiver(streamUrl: string) {
  fireEvent.click(
    screen.getByRole("button", { name: "Switch receiver", exact: true }),
  );
  fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
    target: { value: streamUrl },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  return await openLatestReceiver();
}

async function openSource(source = ControllableEventSource.instances.at(-1)!) {
  await act(async () => source.onopen?.(new Event("open")));
  return source;
}

async function sessionMetadata(
  source: ControllableEventSource,
  metadata: unknown,
) {
  await act(async () =>
    source.dispatchEvent(
      new MessageEvent("sentry.local.session", {
        data: JSON.stringify(metadata),
      }),
    ),
  );
}

async function sendEvent(
  source: ControllableEventSource,
  message: string,
  id: string,
) {
  await act(async () =>
    source.dispatchEvent(
      new MessageEvent("application/x-sentry-envelope", {
        data: JSON.stringify([{}, [[{ type: "event" }, { message }]]]),
        lastEventId: id,
      }),
    ),
  );
}

function captureAction(name: string): HTMLButtonElement {
  let action = screen.queryByRole("button", { name, exact: true });
  if (!action) {
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Capture actions",
        exact: true,
      })[0]!,
    );
    action = screen.getByRole("button", { name, exact: true });
  }
  return action as HTMLButtonElement;
}

function openSettings() {
  fireEvent.click(
    screen.getByRole("button", { name: "Settings", exact: true }),
  );
  return screen.getByRole("dialog", { name: "Settings", exact: true });
}

beforeEach(() => {
  render(<NuqsTestingAdapter>{null}</NuqsTestingAdapter>).unmount();
  window.localStorage.clear();
  window.sessionStorage.clear();
  ControllableEventSource.instances = [];
  vi.stubGlobal("EventSource", ControllableEventSource);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

test("retained SSE metadata shows the actual saved deadline and stops cleanly", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  renderCapture();
  const source = await openSource();
  await sendEvent(source, "saved checkout failure", "saved-event");
  await sessionMetadata(source, { state: "retained", expiresAt: EXPIRES_AT });
  expect(source.closed).toBe(true);
  expect(
    screen.getByRole("status", { name: "Capture state" }).textContent,
  ).toBe("Saved capture");
  const header = screen.getByRole("banner", { name: "Capture context" });
  expect(header.textContent).toContain("Saved until");
  expect(
    header.querySelector(
      `time[datetime="${new Date(EXPIRES_AT).toISOString()}"]`,
    ),
  ).not.toBeNull();
  expect(screen.getByTestId("event-list").textContent).toContain(
    "saved checkout failure",
  );
  const settings = openSettings();
  expect(within(settings).getByText("Saved until")).not.toBeNull();
  expect(settings.querySelector("time")?.dateTime).toBe(
    new Date(EXPIRES_AT).toISOString(),
  );
  expect(request).not.toHaveBeenCalled();
});

test.each([
  undefined,
  0,
  -1,
  1.5,
  "1795000000000",
  Number.MAX_SAFE_INTEGER + 1,
])(
  "invalid or omitted optional expiry %s never invents a saved deadline",
  async (expiresAt) => {
    renderCapture();
    const source = await openSource();
    await sessionMetadata(source, { state: "retained", expiresAt });
    expect(
      screen.getByRole("status", { name: "Capture state" }).textContent,
    ).toBe("Saved capture");
    expect(screen.queryByText(/Saved until/)).toBeNull();
    const settings = openSettings();
    expect(within(settings).queryByText("Saved until")).toBeNull();
  },
);

test("switching captures clears the old label and deadline before new metadata", async () => {
  const sessions = [
    {
      id: "web",
      label: "Web checkout",
      cwd: "/web",
      state: "open",
      streamUrl: STREAM,
    },
    {
      id: "worker",
      label: "Worker jobs",
      cwd: "/worker",
      state: "open",
      streamUrl: WORKER_STREAM,
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ sessions }), {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  renderCapture({ directory: true });
  const first = await openSource();
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Session", exact: true })
        .textContent,
    ).toContain("Web checkout"),
  );
  await sessionMetadata(first, { state: "retained", expiresAt: EXPIRES_AT });
  expect(
    screen.getByRole("banner", { name: "Capture context" }).textContent,
  ).toContain("Saved until");
  fireEvent.click(
    screen.getByRole("combobox", { name: "Session", exact: true }),
  );
  fireEvent.click(
    await screen.findByRole("option", { name: /^Worker jobs ·/ }),
  );
  const second = await openSource();
  expect(second).not.toBe(first);
  const header = screen.getByRole("banner", { name: "Capture context" });
  expect(header.textContent).toContain("Worker jobs");
  expect(header.textContent).not.toContain("Web checkout");
  expect(header.textContent).not.toContain("Saved until");
  expect(
    screen.getByRole("status", { name: "Capture state" }).textContent,
  ).toBe("Capturing");
  const settings = openSettings();
  expect(settings.textContent).toContain("For capture: Worker jobs");
  expect(settings.textContent).not.toContain("Web checkout");
  expect(settings.textContent).not.toContain("Saved until");
});

test("an empty saved traces view describes stopped history without promising future traces", async () => {
  renderCapture({ path: "/traces" });
  const source = await openSource();
  await sendEvent(source, "unrelated error", "non-trace");
  await sessionMetadata(source, { state: "retained", expiresAt: EXPIRES_AT });
  expect(
    screen.getByRole("heading", { name: "No traces saved" }),
  ).not.toBeNull();
  expect(
    screen.getByText(
      "This capture has stopped and its saved history contains no traces.",
    ),
  ).not.toBeNull();
  expect(screen.queryByText(/Transactions and spans.*will appear/)).toBeNull();
});

test("deletion cancellation sends no HTTP and confirmation mutates only the scoped capture", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", request);
  renderCapture();
  const source = await openSource();
  await sendEvent(source, "keep until confirmed", "confirm-event");
  fireEvent.click(captureAction("Delete captured events"));
  const confirmation = screen.getByRole("dialog", {
    name: "Delete captured events?",
  });
  expect(confirmation.textContent).toContain(
    "Other viewers lose this history too",
  );
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(
    screen.queryByRole("dialog", { name: "Search this session" }),
  ).toBeNull();
  expect(screen.getByRole("dialog", { name: "Delete captured events?" })).toBe(
    confirmation,
  );
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Cancel", exact: true }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(request).not.toHaveBeenCalled();
  expect(source.closed).toBe(false);
  expect(screen.getByTestId("event-list").textContent).toContain(
    "keep until confirmed",
  );
  fireEvent.click(captureAction("Delete captured events"));
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: "Delete captured events?" }),
    ).getByRole("button", { name: "Delete captured events", exact: true }),
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const [url, options] = request.mock.calls[0]!;
  expect(String(url)).toBe(
    "http://127.0.0.1:8969/_local/v1/sessions/web/ui/reset?cap=web-read",
  );
  expect(options).toMatchObject({ method: "POST" });
  expect(screen.queryByText("keep until confirmed")).toBeNull();
  expect(
    screen.getByRole("heading", { name: "No events captured" }),
  ).not.toBeNull();
  expect(screen.queryByText(/Clear view only affects this tab/)).toBeNull();
});

test("a receiver reset describes empty capture history without tab-only recovery guidance", async () => {
  renderCapture();
  const source = await openSource();
  await sendEvent(source, "deleted at receiver", "reset-event");
  await sessionMetadata(source, { state: "open", action: "reset" });
  expect(screen.queryByText("deleted at receiver")).toBeNull();
  expect(
    screen.getByRole("heading", { name: "No events captured" }),
  ).not.toBeNull();
  expect(screen.queryByText(/Clear view only affects this tab/)).toBeNull();
  expect(source.closed).toBe(false);
});

test("pending deletion disables Reload capture and ignores queued events until clean replay", async () => {
  let finishReset!: (response: Response) => void;
  const pendingReset = new Promise<Response>((resolve) => {
    finishReset = resolve;
  });
  const request = vi.fn().mockReturnValue(pendingReset);
  vi.stubGlobal("fetch", request);
  renderCapture();
  const beforeReset = await openSource();
  await sendEvent(beforeReset, "before pending reset", "before-pending");
  fireEvent.click(captureAction("Delete captured events"));
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: "Delete captured events?" }),
    ).getByRole("button", { name: "Delete captured events", exact: true }),
  );
  expect(request).toHaveBeenCalledTimes(1);
  const reload = screen.getByRole("button", {
    name: "Reload capture",
    exact: true,
  }) as HTMLButtonElement;
  expect(reload.disabled).toBe(true);
  fireEvent.click(reload);
  expect(ControllableEventSource.instances).toHaveLength(1);
  expect(beforeReset.closed).toBe(true);
  await sendEvent(beforeReset, "queued before deletion", "queued-before");
  expect(screen.queryByText("queued before deletion")).toBeNull();
  await act(async () => finishReset(new Response(null, { status: 204 })));
  await waitFor(() =>
    expect(ControllableEventSource.instances).toHaveLength(2),
  );
  const replay = await openSource();
  expect(replay).not.toBe(beforeReset);
  await sendEvent(replay, "captured after deletion", "after-pending");
  expect(screen.getByTestId("event-list").textContent).toContain(
    "captured after deletion",
  );
  expect(screen.getByTestId("event-list").textContent).not.toContain(
    "before pending reset",
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Reload capture",
        exact: true,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});

test("a successful remote connection survives page reload despite an older saved loopback", async () => {
  window.localStorage.setItem(STREAM_STORAGE_KEY, STREAM);
  renderCapture();
  await openSource();
  const remote = await switchReceiver(REMOTE_STREAM);
  expect(remote.url).toBe(REMOTE_STREAM);
  expect(window.sessionStorage.getItem(REMOTE_STREAM_STORAGE_KEY)).toBe(
    REMOTE_STREAM,
  );
  expect(window.localStorage.getItem(STREAM_STORAGE_KEY)).toBe(STREAM);
  expect(window.location.hash).toBe("");
  cleanup();
  renderViewer();
  const restored = await openSource();
  expect(restored.url).toBe(REMOTE_STREAM);
  expect(
    screen.getByRole("banner", { name: "Capture context" }).textContent,
  ).toContain("Remote capture");
});

test("switching from remote to loopback clears the remote choice before page reload", async () => {
  renderCapture();
  await openSource();
  await switchReceiver(REMOTE_STREAM);
  expect(window.sessionStorage.getItem(REMOTE_STREAM_STORAGE_KEY)).toBe(
    REMOTE_STREAM,
  );
  const local = await switchReceiver(STREAM);
  expect(new URL(local.url).pathname).toBe(new URL(STREAM).pathname);
  expect(window.localStorage.getItem(STREAM_STORAGE_KEY)).toBe(STREAM);
  expect(window.sessionStorage.getItem(REMOTE_STREAM_STORAGE_KEY)).toBeNull();
  cleanup();
  renderViewer();
  const restored = await openSource();
  expect(new URL(restored.url).origin).toBe(new URL(STREAM).origin);
  expect(new URL(restored.url).pathname).toBe(new URL(STREAM).pathname);
  expect(restored.url).not.toBe(REMOTE_STREAM);
});

test.each(["capturing", "saved"] as const)(
  "reloading the same %s capture clears tab-only empty guidance in other views",
  async (state) => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    renderCapture({ path: "/traces" });
    const initial = await openSource();
    await sendEvent(initial, "saved event without traces", "reload-event");
    if (state === "saved")
      await sessionMetadata(initial, {
        state: "retained",
        expiresAt: EXPIRES_AT,
      });
    fireEvent.click(captureAction("Clear view"));
    expect(
      screen.getByRole("heading", { name: "No traces displayed" }),
    ).not.toBeNull();
    expect(screen.getByText(/Clear view only affects this tab/)).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Reload capture", exact: true }),
    );
    const replay = await openSource();
    expect(replay).not.toBe(initial);
    await sendEvent(replay, "saved event without traces", "reload-event");
    if (state === "saved")
      await sessionMetadata(replay, {
        state: "retained",
        expiresAt: EXPIRES_AT,
      });
    expect(
      screen.getByRole("heading", {
        name: state === "saved" ? "No traces saved" : "No traces captured",
      }),
    ).not.toBeNull();
    expect(screen.queryByText(/Clear view only affects this tab/)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  },
);

test("session command search leaves the active view filter unchanged until Filter is chosen", async () => {
  renderCapture();
  const source = await openSource();
  await sendEvent(source, "alpha checkout", "alpha-event");
  await sendEvent(source, "beta worker", "beta-event");
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter Events" }), {
    target: { value: "alpha" },
  });
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "View event event" }),
    ).toHaveLength(1),
  );
  expect(screen.getByTestId("event-list").textContent).toContain(
    "alpha checkout",
  );
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "Search this session",
      exact: true,
    })[0]!,
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "Search this session", exact: true }),
    {
      target: { value: "beta" },
    },
  );
  expect(
    await screen.findByRole("option", { name: /beta worker/i }),
  ).not.toBeNull();
  expect(new URLSearchParams(window.location.search).get("q")).toBe("alpha");
  expect(screen.getByTestId("event-list").textContent).toContain(
    "alpha checkout",
  );
  expect(screen.getByTestId("event-list").textContent).not.toContain(
    "beta worker",
  );
  fireEvent.click(
    screen.getByRole("option", { name: "Filter Events for “beta”" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("event-list").textContent).toContain(
      "beta worker",
    ),
  );
  expect(new URLSearchParams(window.location.search).get("q")).toBe("beta");
  fireEvent.click(
    screen.getByRole("button", { name: "Clear filter", exact: true }),
  );
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "View event event" }),
    ).toHaveLength(2),
  );
});
