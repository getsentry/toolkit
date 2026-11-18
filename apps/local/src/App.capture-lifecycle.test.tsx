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
import {
  pythonLoggingEvent,
  sdkErrorMessage,
} from "./test-fixtures/sdk-message.ts";

const STREAM =
  "http://127.0.0.1:8969/_local/v1/sessions/web/stream?cap=web-read";
const WORKER_STREAM =
  "http://127.0.0.1:8969/_local/v1/sessions/worker/stream?cap=worker-read";
const DIRECTORY =
  "http://127.0.0.1:8969/_local/v1/ui/sessions?cap=directory-read";
const EXPIRES_AT = Date.now() + 3 * 60 * 60 * 1000;
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

async function sendItems(
  source: ControllableEventSource,
  id: string,
  items: [Record<string, unknown>, unknown][],
) {
  await act(async () =>
    source.dispatchEvent(
      new MessageEvent("application/x-sentry-envelope", {
        data: JSON.stringify([{}, items]),
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
      screen.getAllByRole("button", { name: /^View event:/ }),
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
      screen.getAllByRole("button", { name: /^View event:/ }),
    ).toHaveLength(2),
  );
});

test.each(["connecting", "failed"] as const)(
  "landing edits retain ownership when session discovery completes late (%s)",
  async (phase) => {
    let resolveDirectory!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveDirectory = resolve;
          }),
      ),
    );
    window.history.replaceState(
      null,
      "",
      `/#${new URLSearchParams({ stream: "http://127.0.0.1:8969/stream", directory: DIRECTORY })}`,
    );
    renderViewer();
    await waitFor(() => expect(resolveDirectory).toBeDefined());
    if (phase === "failed")
      await act(async () =>
        ControllableEventSource.instances.at(-1)?.onerror?.(new Event("error")),
      );
    fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
      target: { value: "http://127.0.0.1:8970/stream" },
    });
    const attempts = ControllableEventSource.instances.length;
    await act(async () =>
      resolveDirectory(
        new Response(
          JSON.stringify({
            sessions: [
              {
                id: "web",
                label: "Web",
                cwd: "/web",
                state: "open",
                streamUrl: STREAM,
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    expect(
      (screen.getByLabelText("Receiver endpoint") as HTMLInputElement).value,
    ).toBe("http://127.0.0.1:8970/stream");
    expect(ControllableEventSource.instances).toHaveLength(attempts);
  },
);

test.each(["filtered", "saved", "offline"] as const)(
  "SDK report empty state preserves %s recovery guidance",
  async (state) => {
    renderCapture({ path: state === "filtered" ? "/sdks?q=missing" : "/sdks" });
    const source = await openSource();
    await sendEvent(source, "unrelated event", "sdk-empty");
    if (state === "saved")
      await sessionMetadata(source, {
        state: "retained",
        expiresAt: EXPIRES_AT,
      });
    if (state === "offline")
      await act(async () => source.onerror?.(new Event("error")));
    if (state === "filtered")
      expect(
        screen.getByRole("heading", {
          name: /No matching session or client reports/,
        }),
      ).toBeDefined();
    else if (state === "saved")
      expect(
        screen.getByText(/capture has stopped.*session or client reports/),
      ).toBeDefined();
    else
      expect(
        screen.getByText(
          /Reconnect to the receiver to load available capture history/,
        ),
      ).toBeDefined();
    expect(
      screen.queryByText(/Session and client reports will appear/),
    ).toBeNull();
  },
);

test("envelope times use the receiver's time, not when the viewer loaded them", async () => {
  // The receiver assigns each envelope a UUIDv7 SSE id at ingest.
  const receivedAt = 1_794_947_420_913;
  renderCapture({ path: "/envelopes" });
  const source = await openSource();
  await act(async () =>
    source.dispatchEvent(
      new MessageEvent("application/x-sentry-envelope", {
        data: JSON.stringify([
          { sent_at: "2026-11-17T20:30:30.000Z" },
          [
            [{ type: "event" }, { message: "Checkout failed" }],
            [{ type: "attachment", filename: "log.txt" }, "log"],
          ],
        ]),
        lastEventId: "01a1eb34-12f1-7abc-8def-0123456789ab",
      }),
    ),
  );
  const row = await screen.findByRole("button", { name: /^View envelope/ });
  expect(row.textContent).toContain(new Date(receivedAt).toLocaleTimeString());
  expect(row.textContent).toContain("event, attachment");
  expect(
    screen.getByText(/Last received/).querySelector("time")?.dateTime,
  ).toBe(new Date(receivedAt).toISOString());
});

test("envelopes without a receiver time fall back to their sent_at header", async () => {
  renderCapture({ path: "/envelopes" });
  const source = await openSource();
  await act(async () =>
    source.dispatchEvent(
      new MessageEvent("application/x-sentry-envelope", {
        data: JSON.stringify([
          { sent_at: "2026-11-17T20:30:30.000Z" },
          [[{ type: "event" }, { message: "Checkout failed" }]],
        ]),
        lastEventId: "legacy-envelope",
      }),
    ),
  );
  const row = await screen.findByRole("button", { name: /^View envelope/ });
  expect(row.textContent).toContain(
    new Date("2026-11-17T20:30:30.000Z").toLocaleTimeString(),
  );
});

test("Last received never moves back when a later envelope only has sent_at", async () => {
  const receivedAt = 1_794_947_420_913;
  renderCapture({ path: "/envelopes" });
  const source = await openSource();
  await act(async () =>
    source.dispatchEvent(
      new MessageEvent("application/x-sentry-envelope", {
        data: JSON.stringify([
          {},
          [[{ type: "event" }, { message: "Checkout failed" }]],
        ]),
        lastEventId: "01a1eb34-12f1-7abc-8def-0123456789ab",
      }),
    ),
  );
  await act(async () =>
    source.dispatchEvent(
      new MessageEvent("application/x-sentry-envelope", {
        data: JSON.stringify([
          { sent_at: "2026-11-17T20:00:00.000Z" },
          [[{ type: "event" }, { message: "Retry queued" }]],
        ]),
        lastEventId: "legacy-envelope",
      }),
    ),
  );
  expect(
    screen.getByText(/Last received/).querySelector("time")?.dateTime,
  ).toBe(new Date(receivedAt).toISOString());
});

test("event rows name their kind and title instead of an exception badge", async () => {
  renderCapture({ path: "/errors" });
  const source = await openSource();
  await sendItems(source, "logging", [[{ type: "event" }, pythonLoggingEvent]]);
  await sendItems(source, "message", [[{ type: "event" }, sdkErrorMessage]]);
  const logging = await screen.findByRole("button", {
    name: "View event: Database query failed for orders",
  });
  expect(logging.textContent).toContain("Message");
  expect(logging.textContent).not.toContain("Exception");
  const message = screen.getByRole("button", {
    name: "View event: Payment retry limit reached",
  });
  expect(message.textContent).toContain("Message");
  expect(message.textContent).not.toContain("Exception");
});

test("feedback rows show the feedback message, not the page path", async () => {
  renderCapture({ path: "/feedback" });
  const source = await openSource();
  await sendItems(source, "feedback", [
    [
      { type: "feedback" },
      {
        timestamp: 1730000002.1,
        request: { url: "http://localhost:3000/" },
        contexts: {
          feedback: {
            message: "The checkout button did not complete my order.",
            url: "http://localhost:3000/",
          },
        },
      },
    ],
  ]);
  const row = await screen.findByRole("button", {
    name: "View feedback: The checkout button did not complete my order.",
  });
  expect(row.textContent).toContain(
    "The checkout button did not complete my order.",
  );
});

test("long event titles are shortened in row labels", async () => {
  renderCapture({ path: "/errors" });
  const source = await openSource();
  const message = `Query failed: ${"SELECT * FROM orders ".repeat(20)}`;
  await sendItems(source, "long", [
    [{ type: "event" }, { level: "error", message }],
  ]);
  const row = await screen.findByRole("button", {
    name: /^View event: Query failed/,
  });
  const label = row.getAttribute("aria-label") ?? "";
  expect(label.length).toBeLessThanOrEqual(140);
  expect(label.endsWith("…")).toBe(true);
  expect(row.textContent).toContain(message.trim());
});

test("replay recordings show when they were received instead of unknown time", async () => {
  // @sentry/browser replay: a replay_event with a timestamp, then a recording without one.
  const receivedAt = 1_794_947_420_913;
  renderCapture({ path: "/live" });
  const source = await openSource();
  await act(async () =>
    source.dispatchEvent(
      new MessageEvent("application/x-sentry-envelope", {
        data: JSON.stringify([
          { event_id: "4d1c5b0e9a3f4c7e8b2a6f1d0c9e8b7a" },
          [
            [
              { type: "replay_recording" },
              { data: "H4sIAAAAAAAAA4uOBQApu0wNAgAAAA==" },
            ],
          ],
        ]),
        lastEventId: "01a1eb34-12f1-7abc-8def-0123456789ab",
      }),
    ),
  );
  const row = await screen.findByRole("button", { name: /replay recording/i });
  expect(row.textContent).not.toContain("unknown time");
  expect(row.textContent).toContain(new Date(receivedAt).toLocaleTimeString());
});

test("an untimed item in a trace does not stretch the trace to its receive time", async () => {
  // A 400 ms transaction, then a sentry-python cron check-in in the same
  // trace that the receiver got 222 s later. Check-ins carry no timestamp.
  const uuidv7 = (ms: number) =>
    `${ms
      .toString(16)
      .padStart(12, "0")
      .replace(/^(.{8})(.{4})$/, "$1-$2")}-7abc-8def-0123456789ab`;
  const finishedAt = 1_794_947_420.913;
  const traceId = "8f2a6c1e4b7d4f0a9c3e5b1d7a2f6c8e";
  renderCapture({ path: "/traces" });
  const source = await openSource();
  const send = (lastEventId: string, items: unknown[]) =>
    act(async () =>
      source.dispatchEvent(
        new MessageEvent("application/x-sentry-envelope", {
          data: JSON.stringify([{}, items]),
          lastEventId,
        }),
      ),
    );
  await send(uuidv7(finishedAt * 1000 + 50), [
    [
      { type: "transaction" },
      {
        type: "transaction",
        transaction: "nightly-report",
        start_timestamp: finishedAt - 0.4,
        timestamp: finishedAt,
        contexts: {
          trace: { trace_id: traceId, span_id: "a1b2c3d4e5f60718", op: "task" },
        },
      },
    ],
  ]);
  await send(uuidv7(finishedAt * 1000 + 222_000), [
    [
      { type: "check_in" },
      {
        check_in_id: "5f1c0e8a2b9d4c7e8f3a1b6d0c9e2f4a",
        monitor_slug: "nightly-report",
        status: "ok",
        duration: 0.4,
        contexts: { trace: { trace_id: traceId, span_id: "a1b2c3d4e5f60718" } },
      },
    ],
  ]);
  const row = await screen.findByRole("button", {
    name: "View trace nightly-report",
  });
  expect(row.textContent).toMatch(/400(\.0+)? ms/);
  expect(row.textContent).not.toContain("222");
});
