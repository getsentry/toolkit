import { createSpotlightBuffer } from "@spotlightjs/spotlight/sdk";
import { EventSource as NodeEventSource } from "eventsource";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { BrowserRouter } from "react-router";
import { ThemeProvider } from "@/components/theme-provider.tsx";
import { createLocalRetentionBuffer } from "../../../packages/cli/src/commands/local/retention-buffer.ts";
import App from "./App.tsx";
import { sdkException } from "./test-fixtures/sdk-exception.ts";
import { LocalWorkspaceRoute } from "./routes/local-workspace-route.tsx";
import {
  REMOTE_STREAM_STORAGE_KEY,
  STREAM_STORAGE_KEY,
} from "./lib/spotlight.ts";
import {
  buildApp,
  tryListen,
} from "../../../packages/cli/src/commands/local/server.ts";

const SENTRY_CONTENT_TYPE = "application/x-sentry-envelope";

type EnvelopeOptions = {
  level?: string;
  operation?: string;
  spanId?: string;
  spans?: unknown[];
  statusCode?: number;
  startTimestamp?: number;
  traceId?: string;
  type?: string;
};

function envelope(transaction: string, options: EnvelopeOptions = {}): string {
  return [
    JSON.stringify({ event_id: crypto.randomUUID() }),
    JSON.stringify({ type: options.type ?? "transaction" }),
    JSON.stringify({
      transaction,
      timestamp: 1_700_000_000,
      ...(options.startTimestamp
        ? { start_timestamp: options.startTimestamp }
        : {}),
      ...(options.level ? { level: options.level } : {}),
      ...(options.traceId || options.operation
        ? {
            contexts: {
              trace: {
                ...(options.traceId ? { trace_id: options.traceId } : {}),
                ...(options.spanId ? { span_id: options.spanId } : {}),
                ...(options.operation ? { op: options.operation } : {}),
              },
            },
          }
        : {}),
      ...(options.statusCode
        ? { request: { status_code: options.statusCode } }
        : {}),
      ...(options.spans ? { spans: options.spans } : {}),
    }),
    "",
  ].join("\n");
}

async function startReceiver() {
  return tryListen(
    buildApp(createSpotlightBuffer(10), { uiActions: true }),
    0,
    "127.0.0.1",
  );
}

async function stopReceiver(
  server: Awaited<ReturnType<typeof startReceiver>>["server"],
) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // Node 22 can otherwise wait for old SSE/probe keep-alive sockets during teardown.
    server.closeAllConnections();
  });
}

async function sendEnvelope(
  port: number,
  transaction: string,
  options?: EnvelopeOptions,
) {
  const response = await fetch(`http://127.0.0.1:${port}/stream`, {
    method: "POST",
    headers: { "Content-Type": SENTRY_CONTENT_TYPE },
    body: envelope(transaction, options),
  });
  expect(response.status).toBe(204);
}

function renderViewer(port: number, path = "/") {
  window.history.replaceState(
    null,
    "",
    `${path}#stream=${encodeURIComponent(`http://127.0.0.1:${port}/stream`)}`,
  );
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

function renderBareViewer() {
  window.history.replaceState(null, "", "/");
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

class OpeningEventSource extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(_url: string) {
    super();
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  close() {}
}

class ControllableEventSource extends EventTarget {
  static instances: ControllableEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(_url: string) {
    super();
    ControllableEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

/** Open the replacement probe, then the committed replay stream when one is created. */
async function openLatestReceiver() {
  const probe = ControllableEventSource.instances.at(-1)!;
  await act(async () => probe.onopen?.(new Event("open")));
  const current = ControllableEventSource.instances.at(-1)!;
  if (current !== probe)
    await act(async () => current.onopen?.(new Event("open")));
  return current;
}

describe("local receiver to viewer integration", () => {
  beforeEach(() => {
    // Nuqs shares pending URL updates across mounts. Reset them between tests
    // while keeping the real browser adapter for history integration coverage.
    render(<NuqsTestingAdapter>{null}</NuqsTestingAdapter>).unmount();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });
    vi.stubGlobal("EventSource", NodeEventSource);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  test("Add receiver is a dismissible modal that keeps the live feed and restores focus", async () => {
    const receiver = await startReceiver();
    try {
      renderViewer(receiver.port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(receiver.port, "GET /keep-live");
      await screen.findByLabelText("View transaction event");
      const trigger = screen.getByRole("button", {
        name: "Add receiver",
        exact: true,
      });
      fireEvent.click(trigger);
      const dialog = screen.getByRole("dialog", { name: "Add receiver" });
      expect(document.body.style.pointerEvents).toBe("none");
      expect(screen.queryByRole("button", { name: "Clear events" })).toBeNull();
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(trigger);
      expect(screen.getByTestId("event-list").textContent).toContain(
        "/keep-live",
      );
      fireEvent.click(trigger);
      fireEvent.click(
        screen.getByRole("button", { name: "Close", exact: true }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      fireEvent.click(trigger);
      const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
      // Radix registers outside-pointer listeners on the next task.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      fireEvent.pointerDown(overlay, { pointerType: "mouse", button: 0 });
      fireEvent.click(overlay);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      cleanup();
      await stopReceiver(receiver.server);
    }
  });

  test("a failed or cancelled Add receiver attempt keeps the current stream and events", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();
    const first = ControllableEventSource.instances[0]!;
    await act(async () => {
      first.onopen?.(new Event("open"));
      first.dispatchEvent(
        new MessageEvent(SENTRY_CONTENT_TYPE, {
          data: JSON.stringify([
            {},
            [[{ type: "event" }, { message: "keep this event" }]],
          ]),
        }),
      );
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add receiver", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
      target: { value: "http://127.0.0.1:8970/stream" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Connect", exact: true }),
    );
    const candidate = ControllableEventSource.instances.at(-1)!;
    await act(async () => candidate.onerror?.(new Event("error")));
    expect(first.closed).toBe(false);
    expect(screen.getByRole("dialog", { name: "Add receiver" })).not.toBeNull();
    expect(
      screen.getByRole("alert", { name: "Receiver connection error" })
        .textContent,
    ).toContain("Could not connect");
    fireEvent.click(
      screen.getByRole("button", { name: "Connect", exact: true }),
    );
    const cancelled = ControllableEventSource.instances.at(-1)!;
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(cancelled.closed).toBe(true);
    await act(async () => cancelled.onopen?.(new Event("open")));
    expect(first.closed).toBe(false);
    expect(screen.getByTestId("event-list").textContent).toContain(
      "keep this event",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Settings blocks the background, closes on outside click and restores its trigger", async () => {
    vi.stubGlobal("EventSource", OpeningEventSource);
    renderBareViewer();
    await screen.findByText("Connected to local receiver");
    const trigger = screen.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    fireEvent.click(trigger);
    expect(document.body.style.pointerEvents).toBe("none");
    expect(screen.queryByRole("button", { name: "Clear events" })).toBeNull();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.pointerDown(overlay, { pointerType: "mouse", button: 0 });
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  test("editing the connection landing prevents a late automatic connection from dismissing it", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();
    const automatic = ControllableEventSource.instances[0]!;
    fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
      target: { value: "http://127.0.0.1:8970/stream" },
    });
    expect(automatic.closed).toBe(true);
    await act(async () => automatic.onopen?.(new Event("open")));
    expect(screen.getByLabelText("Receiver endpoint")).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect", exact: true }),
    );
    await openLatestReceiver();
    await screen.findByText("Connected to local receiver");
    expect(window.localStorage.getItem(STREAM_STORAGE_KEY)).toBe(
      "http://127.0.0.1:8970/stream",
    );
  });

  test("appearance Settings remain available without a connected receiver", () => {
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();
    fireEvent.click(
      screen.getByRole("button", { name: "Settings", exact: true }),
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dark", exact: true }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(
      screen.getByText("This receiver does not provide retention settings."),
    ).not.toBeNull();
  });

  test("Settings changes and persists the viewer theme without reconnecting the receiver", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderViewer(8969);
    await act(async () =>
      ControllableEventSource.instances.at(-1)?.onopen?.(new Event("open")),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Settings", exact: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dark", exact: true }));
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
    expect(window.localStorage.getItem("theme")).toBe("dark");
    expect(ControllableEventSource.instances).toHaveLength(1);
    expect(ControllableEventSource.instances[0]?.closed).toBe(false);

    cleanup();
    renderViewer(8969);
    await act(async () =>
      ControllableEventSource.instances.at(-1)?.onopen?.(new Event("open")),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Settings", exact: true }),
    );
    expect(
      screen
        .getByRole("button", { name: "Dark", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Light", exact: true }));
    await waitFor(() =>
      expect(document.documentElement.classList.contains("light")).toBe(true),
    );
    expect(window.localStorage.getItem("theme")).toBe("light");
    fireEvent.click(
      screen.getByRole("button", { name: "System", exact: true }),
    );
    expect(window.localStorage.getItem("theme")).toBe("system");
    expect(
      screen
        .getByRole("button", { name: "System", exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(ControllableEventSource.instances).toHaveLength(2);
    expect(ControllableEventSource.instances[1]?.closed).toBe(false);
  });

  test("shows SDK exception titles, causes and stacks in Overview without losing JSON", async () => {
    const { server, port } = await startReceiver();
    try {
      renderViewer(port, "/errors");
      await screen.findByText("Connected to local receiver");
      const response = await fetch(`http://127.0.0.1:${port}/stream`, {
        method: "POST",
        headers: { "Content-Type": SENTRY_CONTENT_TYPE },
        body: ["{}", '{"type":"event"}', JSON.stringify(sdkException)].join(
          "\n",
        ),
      });
      expect(response.status).toBe(204);
      const row = await screen.findByRole("button", {
        name: "View event event",
      });
      expect(row.textContent).toContain(
        "TypeError: Cannot read properties of undefined (reading 'total')",
      );
      expect(row.textContent).not.toContain("/checkout");
      const detail = screen.getByTestId("event-detail");
      await waitFor(() => expect(detail.textContent).toContain("submitOrder"));
      expect(detail.textContent).toContain("/app/checkout.ts:42:17");
      expect(detail.textContent).toContain(
        'throw new TypeError("Checkout failed");',
      );
      expect(detail.textContent).toContain("Caused by");
      expect(detail.textContent).toContain(
        "Error: Payment gateway unavailable",
      );
      expect(detail.textContent).toContain("/app/gateway.ts:15:8");
      expect(detail.textContent).not.toContain("No additional event details.");
      const frames = screen.getAllByRole("list", { name: "Stack frames" });
      expect(frames[0]?.textContent?.indexOf("submitOrder")).toBeLessThan(
        frames[0]!.textContent!.indexOf("runMain"),
      );
      fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
      await waitFor(() =>
        expect(screen.getByTestId("highlighted-json").textContent).toContain(
          '"exception"',
        ),
      );
      expect(
        JSON.parse(screen.getByTestId("highlighted-json").textContent!),
      ).toEqual({ ...sdkException, type: "event" });
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("shows message-only SDK errors in the title and Overview", async () => {
    const { server, port } = await startReceiver();
    try {
      renderViewer(port, "/errors");
      await screen.findByText("Connected to local receiver");
      await fetch(`http://127.0.0.1:${port}/stream`, {
        method: "POST",
        headers: { "Content-Type": SENTRY_CONTENT_TYPE },
        body: [
          "{}",
          '{"type":"event"}',
          JSON.stringify({
            level: "error",
            message: "Checkout rejected",
            transaction: "POST /checkout",
            request: { url: "https://example.test/checkout" },
          }),
        ].join("\n"),
      });
      const row = await screen.findByRole("button", {
        name: "View event event",
      });
      expect(row.textContent).toContain("Checkout rejected");
      const detail = screen.getByTestId("event-detail");
      expect(detail.textContent).toContain("Message");
      expect(detail.textContent).toContain("Checkout rejected");
      expect(detail.textContent).not.toContain("No additional event details.");
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("System appearance follows live device changes while explicit choices stay fixed", async () => {
    let prefersDark = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return prefersDark;
      },
      media: query,
      addListener: (listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    }));
    const changeSystemTheme = async (dark: boolean) => {
      prefersDark = dark;
      await act(async () => {
        const event = Object.assign(new Event("change"), {
          matches: dark,
          media: "(prefers-color-scheme: dark)",
        }) as MediaQueryListEvent;
        for (const listener of listeners) listener(event);
      });
    };
    window.localStorage.setItem("theme", "system");
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderViewer(8969);
    await act(async () =>
      ControllableEventSource.instances[0]?.onopen?.(new Event("open")),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Settings", exact: true }),
    );
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(screen.getByText("System appearance: Light")).not.toBeNull();
    await changeSystemTheme(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByText("System appearance: Dark")).not.toBeNull();
    await changeSystemTheme(false);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dark", exact: true }));
    await changeSystemTheme(true);
    await changeSystemTheme(false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "System", exact: true }),
    );
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(ControllableEventSource.instances).toHaveLength(1);
    expect(ControllableEventSource.instances[0]?.closed).toBe(false);
    expect(window.localStorage.getItem("theme")).toBe("system");
  });

  test("keeps the selected live transaction open in the detail pane", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");

      const shell = screen.getByTestId("app-shell");
      expect(shell.className).not.toContain("px-");
      expect(shell.className).not.toContain("py-");
      expect(screen.queryByRole("banner")).toBeNull();

      await sendEnvelope(port, "GET /live");
      await screen.findByLabelText("View transaction event");
      await sendEnvelope(port, "GET /live-2");

      await waitFor(() => {
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          2,
        );
      });
      const eventList = screen.getByTestId("event-list");
      expect(eventList.className).toContain("flex-1");
      expect(eventList.className).not.toContain("max-h-[42rem]");
      expect(
        screen.getByRole("complementary", { name: "Live Activity" }),
      ).not.toBeNull();
      const detail = screen.getByTestId("event-detail");
      expect(detail.textContent).toContain("GET /live");
      expect(detail.textContent).not.toContain("GET /live-2");
      expect(detail.textContent).not.toContain("GETGET /live");

      const events = screen.getAllByLabelText("View transaction event");
      fireEvent.click(events[1]!);

      await waitFor(() => {
        expect(screen.getByTestId("event-detail").textContent).toContain(
          "GET /live-2",
        );
      });
      expect(screen.getByRole("tab", { name: "Overview" })).not.toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
      const code = screen.getByTestId("highlighted-json");
      expect(code.textContent).toContain("GET /live-2");
      fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
      expect(
        await screen.findByRole("status", { name: "JSON copied" }),
      ).not.toBeNull();
      await waitFor(() => {
        expect(
          screen.getByTestId("highlighted-json").querySelector(".shiki"),
        ).not.toBeNull();
      });
      fireEvent.click(events[0]!);
      fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
      expect(
        screen.getByRole("button", { name: "Copy JSON" }).textContent,
      ).toContain("Copy JSON");
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("keeps direct receiver actions in a compact sidebar utility bar", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /dock");
      await screen.findByLabelText("View transaction event");

      const sidebar = screen.getByLabelText("Workspace navigation");
      const utilityBar = sidebar.querySelector(
        '[data-testid="sidebar-utility-bar"]',
      );
      expect(utilityBar).not.toBeNull();
      expect(utilityBar?.textContent).toContain("Connected");
      expect(
        utilityBar?.querySelector('button[aria-label="Search events"]'),
      ).not.toBeNull();
      expect(
        utilityBar
          ?.querySelector('[role="status"]')
          ?.getAttribute("aria-label"),
      ).toBe("Connected to local receiver");
      expect(
        sidebar.querySelector('button[aria-label="Add receiver"]'),
      ).not.toBeNull();
      expect(
        sidebar.querySelector('button[aria-label="Clear events"]'),
      ).not.toBeNull();
      expect(screen.queryByRole("banner")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(
        screen.getByRole("button", { name: "Open live activity view" })
          .className,
      ).toContain("justify-center");
      expect(
        utilityBar?.querySelector('button[aria-label="Search events"]')
          ?.className,
      ).toContain("mx-auto");

      fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));
      expect(
        await screen.findByRole("dialog", { name: "Add receiver" }),
      ).not.toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("offers a useful connection landing for a bare viewer visit", () => {
    renderBareViewer();

    expect(screen.getByAltText("Sentry CLI")).not.toBeNull();
    expect(screen.getByRole("banner").textContent).not.toContain(
      "Receiver setup",
    );
    expect(
      screen.queryByRole("searchbox", { name: "Search events" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Workspace navigation")).toBeNull();
    expect(screen.getByText("Connecting to receiver")).not.toBeNull();
    expect(
      screen.getByRole("status", { name: "Checking receiver" }),
    ).not.toBeNull();
    expect(screen.queryByText("Advanced connection")).toBeNull();
    const endpoint = screen.getByLabelText(
      "Receiver endpoint",
    ) as HTMLInputElement;
    expect(endpoint.value).toBe("http://localhost:8969/stream");
    const connectButton = screen.getByRole("button", {
      name: "Connect",
    }) as HTMLButtonElement;
    expect(connectButton.disabled).toBe(false);
    expect(connectButton.getAttribute("aria-busy")).toBe("false");
    expect(
      screen.getByText("Paste a local /stream address or an HTTPS stream URL."),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy local serve command" }),
    ).not.toBeNull();
  });

  test("renders every Explorer view from a receiver-backed telemetry session", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /trace");
      await sendEnvelope(port, "GET /error", { type: "event", level: "error" });
      await sendEnvelope(port, "GET /logs", { type: "log" });
      await sendEnvelope(port, "GET /feedback", { type: "user_report" });
      await sendEnvelope(port, "GET /profile", { type: "profile" });
      await sendEnvelope(port, "GET /sdk", { type: "client_report" });
      await sendEnvelope(port, "GET /ai", { operation: "ai.generate" });

      const explorerViews = [
        ["Open live activity view", "View transaction event"],
        ["Open errors view", "View event event"],
        ["Open logs view", "View log event"],
        ["Open feedback view", "View user_report event"],
        ["Open envelopes view", "View envelope event"],
        ["Open profiles view", "View profile event"],
        ["Open sessions & sdks view", "View client_report event"],
        ["Open ai view", "View transaction event"],
      ] as const;

      for (const [view, event] of explorerViews) {
        fireEvent.click(screen.getByRole("button", { name: view }));
        expect((await screen.findAllByLabelText(event)).length).toBeGreaterThan(
          0,
        );
      }

      fireEvent.click(screen.getByRole("button", { name: "Open traces view" }));
      expect(
        await screen.findByRole("region", { name: "Trace waterfall" }),
      ).not.toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("connects a bare viewer to a custom loopback receiver and saves it after opening", async () => {
    const { server, port } = await startReceiver();

    try {
      renderBareViewer();
      fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
        target: { value: `http://127.0.0.1:${port}/stream` },
      });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await screen.findByText("Connected to local receiver");
      expect(window.localStorage.getItem("sentry.local.stream-url")).toBe(
        `http://127.0.0.1:${port}/stream`,
      );
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("past connections survive reload and reconnect isolated feeds without pasting endpoints", async () => {
    const first = await startReceiver();
    const second = await startReceiver();
    try {
      await sendEnvelope(first.port, "GET /past-first");
      await sendEnvelope(second.port, "GET /past-second");
      renderViewer(first.port);
      await screen.findByLabelText("View transaction event");
      fireEvent.click(
        screen.getByRole("button", { name: "Add receiver", exact: true }),
      );
      fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
        target: { value: `http://127.0.0.1:${second.port}/stream` },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Connect", exact: true }),
      );
      await waitFor(() =>
        expect(screen.getByTestId("event-list").textContent).toContain(
          "/past-second",
        ),
      );
      cleanup();
      renderBareViewer();
      await screen.findByLabelText("View transaction event");
      fireEvent.click(
        screen.getByRole("button", { name: "Add receiver", exact: true }),
      );
      const firstLabel = `http://127.0.0.1:${first.port}/stream`;
      const secondLabel = `http://127.0.0.1:${second.port}/stream`;
      expect(
        screen.getByRole("button", {
          name: `Reconnect to ${secondLabel}`,
          exact: true,
        }),
      ).not.toBeNull();
      fireEvent.click(
        screen.getByRole("button", {
          name: `Reconnect to ${firstLabel}`,
          exact: true,
        }),
      );
      await waitFor(() =>
        expect(screen.getByTestId("event-list").textContent).toContain(
          "/past-first",
        ),
      );
      expect(screen.getByTestId("event-list").textContent).not.toContain(
        "/past-second",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Add receiver", exact: true }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: `Forget ${secondLabel}`,
          exact: true,
        }),
      );
      expect(
        screen.queryByRole("button", {
          name: `Reconnect to ${secondLabel}`,
          exact: true,
        }),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Close", exact: true }),
      );
      expect(screen.getByTestId("event-list").textContent).toContain(
        "/past-first",
      );
    } finally {
      cleanup();
      await stopReceiver(first.server);
      await stopReceiver(second.server);
    }
  });

  test("keeps a successfully opened remote receiver only for this browser session", async () => {
    vi.stubGlobal("EventSource", OpeningEventSource);
    renderBareViewer();
    await screen.findByText("Connected to local receiver");
    window.localStorage.clear();
    fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));

    fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
      target: { value: "https://receiver.example/stream?token=abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(window.sessionStorage.getItem(REMOTE_STREAM_STORAGE_KEY)).toBe(
        "https://receiver.example/stream?token=abc",
      );
    });
    expect(window.localStorage.getItem(STREAM_STORAGE_KEY)).toBeNull();
  });

  test("editing a failed landing clears its stale connection error without reconnecting", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();
    const source = ControllableEventSource.instances[0]!;
    await act(async () => source.onerror?.(new Event("error")));
    await screen.findByRole("alert", { name: "Receiver connection error" });
    fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
      target: { value: "http://127.0.0.1:8970/stream" },
    });
    expect(
      screen.queryByRole("alert", { name: "Receiver connection error" }),
    ).toBeNull();
    expect(ControllableEventSource.instances).toHaveLength(1);
    await act(async () => source.onerror?.(new Event("error")));
    expect(
      screen.queryByRole("alert", { name: "Receiver connection error" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect", exact: true }),
    );
    await openLatestReceiver();
    await screen.findByText("Connected to local receiver");
  });

  test("clear ignores pre-reset deliveries and reconnects without replacing the workspace shell", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    window.localStorage.setItem(
      STREAM_STORAGE_KEY,
      "http://127.0.0.1:8969/_local/v1/sessions/reset-run/stream?cap=reset-test",
    );
    let completeReset: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            completeReset = resolve;
          }),
      ),
    );
    renderBareViewer();
    const source = ControllableEventSource.instances[0]!;
    const deliver = (message: string, id: string) =>
      source.dispatchEvent(
        new MessageEvent(SENTRY_CONTENT_TYPE, {
          data: JSON.stringify([{}, [[{ type: "event" }, { message }]]]),
          lastEventId: id,
        }),
      );
    await act(async () => {
      source.onopen?.(new Event("open"));
      deliver("before reset", "before");
    });
    const shell = screen.getByRole("complementary", {
      name: "Workspace navigation",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Clear events", exact: true }),
    );
    await act(async () => deliver("stale queued event", "stale"));
    expect(screen.queryByText("stale queued event")).toBeNull();
    expect(
      screen.getByRole("complementary", { name: "Workspace navigation" }),
    ).toBe(shell);
    await act(async () => completeReset?.(new Response(null, { status: 204 })));
    expect(ControllableEventSource.instances).toHaveLength(2);
    expect(
      screen.getByRole("complementary", { name: "Workspace navigation" }),
    ).toBe(shell);
  });

  test("unchanged Add receiver retries a disconnected scoped session without losing its events or selection", async () => {
    const stream =
      "http://127.0.0.1:8969/_local/v1/sessions/selected-run/stream?cap=session-test";
    const requestedStreams: string[] = [];
    ControllableEventSource.instances = [];
    vi.stubGlobal(
      "EventSource",
      class extends ControllableEventSource {
        constructor(url: string) {
          super(url);
          requestedStreams.push(url);
        }
      },
    );
    window.localStorage.setItem(STREAM_STORAGE_KEY, stream);
    renderBareViewer();
    const source = ControllableEventSource.instances[0]!;
    await act(async () => {
      source.onopen?.(new Event("open"));
      source.dispatchEvent(
        new MessageEvent(SENTRY_CONTENT_TYPE, {
          data: JSON.stringify([
            {},
            [
              [
                { type: "event" },
                { message: "kept scoped event", level: "error" },
              ],
            ],
          ]),
          lastEventId: "kept-scoped",
        }),
      );
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open errors view", exact: true }),
    );
    await screen.findByRole("heading", { name: "Errors", exact: true });
    fireEvent.click(screen.getByRole("tab", { name: "JSON", exact: true }));
    await act(async () => source.onerror?.(new Event("error")));
    await screen.findByRole("heading", {
      name: "Receiver disconnected",
      exact: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add receiver", exact: true }),
    );
    expect(
      (screen.getByLabelText("Receiver endpoint") as HTMLInputElement).value,
    ).toBe("http://127.0.0.1:8969/stream");
    fireEvent.click(
      screen.getByRole("button", { name: "Connect", exact: true }),
    );
    await openLatestReceiver();
    await screen.findByText("Connected to local receiver");
    expect(
      screen.getByRole("heading", { name: "Errors", exact: true }),
    ).not.toBeNull();
    expect(screen.getByTestId("event-detail").textContent).toContain(
      "kept scoped event",
    );
    expect(
      screen
        .getByRole("tab", { name: "JSON", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    const reconnected = new URL(requestedStreams.at(-1)!);
    expect(reconnected.pathname).toBe(new URL(stream).pathname);
    expect(reconnected.searchParams.get("cap")).toBe("session-test");
  });

  test("editing a replacement keeps the disconnected feed's error after closing the modal", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();
    const source = ControllableEventSource.instances[0]!;
    await act(async () => {
      source.onopen?.(new Event("open"));
      source.dispatchEvent(
        new MessageEvent(SENTRY_CONTENT_TYPE, {
          data: JSON.stringify([
            {},
            [[{ type: "event" }, { message: "kept event" }]],
          ]),
          lastEventId: "kept",
        }),
      );
      source.onerror?.(new Event("error"));
    });
    await screen.findByRole("heading", {
      name: "Receiver disconnected",
      exact: true,
    });
    const error =
      "Could not connect to the default receiver. Start it with the command below or enter another endpoint.";
    expect(screen.getByText(error)).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Add receiver", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
      target: { value: "http://127.0.0.1:8970/stream" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(screen.getByText(error)).not.toBeNull();
    expect(screen.getByTestId("event-detail").textContent).toContain(
      "kept event",
    );
  });

  test("keeps endpoint validation visible after a failed receiver has been stopped", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();

    const source = ControllableEventSource.instances[0];
    expect(source).toBeDefined();
    await act(async () => source?.onerror?.(new Event("error")));
    await screen.findByRole("alert", { name: "Receiver connection error" });

    fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
      target: { value: "http://receiver.example/stream" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a loopback stream or an HTTPS remote stream",
    );

    await act(async () => source?.onerror?.(new Event("error")));
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a loopback stream or an HTTPS remote stream",
    );
  });

  test("stops an unanswered receiver attempt after ten seconds", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    vi.useFakeTimers();

    try {
      renderBareViewer();

      const initialSource = ControllableEventSource.instances[0];
      expect(initialSource).toBeDefined();
      await act(async () => initialSource?.onerror?.(new Event("error")));
      fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
        target: { value: "http://127.0.0.1:8970/stream" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      const source = ControllableEventSource.instances[1];
      expect(source).toBeDefined();
      const connectingButton = screen.getByRole("button", {
        name: "Connecting to receiver",
      }) as HTMLButtonElement;
      expect(connectingButton.disabled).toBe(true);
      expect(connectingButton.getAttribute("aria-busy")).toBe("true");

      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });

      expect(source?.closed).toBe(true);
      expect(
        screen.getByRole("alert", { name: "Receiver connection error" })
          .textContent,
      ).toContain("Connection timed out after 10 seconds");
      expect(
        (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  test("keeps receiver selection open when an event arrives during editing", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();

    const source = ControllableEventSource.instances[0];
    expect(source).toBeDefined();
    await act(async () => source?.onopen?.(new Event("open")));
    await screen.findByText("Connected to local receiver");
    fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));

    await act(async () => {
      source?.dispatchEvent(
        new MessageEvent(SENTRY_CONTENT_TYPE, {
          data: JSON.stringify([
            {},
            [
              [
                { type: "transaction" },
                { transaction: "GET /arrived-while-editing" },
              ],
            ],
          ]),
        }),
      );
    });

    expect(screen.getByLabelText("Receiver endpoint")).not.toBeNull();
  });

  test("keeps workspace navigation visible while reconnecting", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();

    const source = ControllableEventSource.instances[0];
    expect(source).toBeDefined();
    await act(async () => source?.onopen?.(new Event("open")));
    await screen.findByText("Connected to local receiver");

    fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));
    fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
      target: { value: "http://127.0.0.1:8970/stream" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByLabelText("Workspace navigation")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Connecting to receiver" }),
    ).not.toBeNull();
  });

  test("keeps a healthy receiver open after an invalid replacement endpoint", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();

    const source = ControllableEventSource.instances[0];
    expect(source).toBeDefined();
    await act(async () => source?.onopen?.(new Event("open")));
    await screen.findByText("Connected to local receiver");
    fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));
    fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
      target: { value: "http://receiver.example/stream" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(source?.closed).toBe(false);
    expect(
      screen.getAllByLabelText("Connected to local receiver")[0],
    ).not.toBeNull();
  });

  test("replays an envelope buffered before the viewer opens", async () => {
    const { server, port } = await startReceiver();

    try {
      await sendEnvelope(port, "GET /buffered");
      renderViewer(port);

      await screen.findByText("Connected to local receiver");
      expect((await screen.findByTestId("event-detail")).textContent).toContain(
        "GET /buffered",
      );
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("does not mark the receiver replay as new events", async () => {
    const { server, port } = await startReceiver();

    try {
      await sendEnvelope(port, "GET /buffered-first");
      await sendEnvelope(port, "GET /buffered-second");
      renderViewer(port);

      await waitFor(() => {
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          2,
        );
      });
      expect(
        screen.queryByRole("button", { name: /View .* new event/ }),
      ).toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("keeps Live Activity unfiltered and uses the sidebar for event classes", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /healthy");
      await sendEnvelope(port, "GET /broken", {
        type: "event",
        level: "error",
      });

      await screen.findByLabelText("View transaction event");
      await screen.findByLabelText("View event event");

      expect(screen.queryByLabelText("Filter events")).toBeNull();
      expect(
        screen.getByLabelText("View transaction event").textContent,
      ).toContain("/healthy");
      expect(screen.getByLabelText("View event event").textContent).toContain(
        "/broken",
      );

      fireEvent.click(screen.getByRole("button", { name: "Open errors view" }));
      expect(screen.queryByLabelText("View transaction event")).toBeNull();
      expect(screen.getByLabelText("View event event").textContent).toContain(
        "/broken",
      );

      await sendEnvelope(port, "GET /another-healthy");
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Open live activity view" })
            .textContent,
        ).toContain("3");
      });
      expect(
        screen.queryByRole("button", { name: /View 1 new event/ }),
      ).toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("uses the collapsible workspace sidebar to focus an observability view", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /healthy");
      await sendEnvelope(port, "GET /broken", {
        type: "event",
        level: "error",
      });

      await screen.findByLabelText("View event event");
      expect(
        screen.getByRole("button", { name: "Open live activity view" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Open errors view" }).textContent,
      ).toContain("1");

      fireEvent.click(screen.getByRole("button", { name: "Open errors view" }));
      expect(
        screen
          .getByRole("button", { name: "Open errors view" })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(screen.getAllByLabelText(/View .* event/)).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(
        screen.getByRole("button", { name: "Expand sidebar" }),
      ).not.toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("restores the collapsed sidebar after a refresh", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

      expect(
        window.localStorage.getItem("sentry.local.sidebar-collapsed"),
      ).toBe("true");

      cleanup();
      renderViewer(port);

      expect(
        await screen.findByRole("button", { name: "Expand sidebar" }),
      ).not.toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("keeps raw received envelopes available outside the live event feed", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /raw-envelope");
      await screen.findByLabelText("View transaction event");

      fireEvent.click(
        screen.getByRole("button", { name: "Open envelopes view" }),
      );

      expect(
        screen.getByRole("button", { name: "Open envelopes view" }).textContent,
      ).toContain("1");
      fireEvent.click(screen.getByLabelText("View envelope event"));
      expect(
        screen.getByRole("heading", { name: "Raw envelope" }),
      ).not.toBeNull();
      expect(screen.getByTestId("event-detail").textContent).toContain(
        "Envelope",
      );
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("offers new raw envelopes after the Envelopes view has been read", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /first-envelope");
      await screen.findByLabelText("View transaction event");

      fireEvent.click(
        screen.getByRole("button", { name: "Open envelopes view" }),
      );
      fireEvent.click(await screen.findByLabelText("View envelope event"));
      await sendEnvelope(port, "GET /second-envelope");

      expect(
        await screen.findByRole("button", { name: "View 1 new envelope" }),
      ).not.toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("enables clearing when only raw envelopes are retained", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();

    const source = ControllableEventSource.instances[0];
    expect(source).toBeDefined();
    await act(async () => source?.onopen?.(new Event("open")));
    await screen.findByText("Connected to local receiver");

    await act(async () => {
      source?.dispatchEvent(
        new MessageEvent(SENTRY_CONTENT_TYPE, {
          data: JSON.stringify([{}, []]),
          lastEventId: "raw-only-envelope",
        }),
      );
    });

    const clearButton = screen.getByRole("button", {
      name: "Clear events",
    }) as HTMLButtonElement;
    await waitFor(() => expect(clearButton.disabled).toBe(false));
    fireEvent.click(
      screen.getByRole("button", { name: "Open envelopes view" }),
    );
    expect(await screen.findByLabelText("View envelope event")).not.toBeNull();
    fireEvent.click(clearButton);

    await waitFor(() => expect(clearButton.disabled).toBe(true));
  });

  test("preserves undecodable raw envelopes and clears their stale alert with the feed", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    renderBareViewer();
    const source = ControllableEventSource.instances[0];
    await act(async () => {
      source?.onopen?.(new Event("open"));
      source?.dispatchEvent(
        new MessageEvent(SENTRY_CONTENT_TYPE, {
          data: "undecodable",
          lastEventId: "raw-broken",
        }),
      );
    });
    await screen.findByText("Received an event that could not be decoded.");
    const clear = screen.getByRole("button", {
      name: "Clear events",
    }) as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Open envelopes view" }),
    );
    await screen.findByLabelText("View envelope event");
    fireEvent.click(clear);
    await waitFor(() =>
      expect(
        screen.queryByText("Received an event that could not be decoded."),
      ).toBeNull(),
    );
    expect(clear.disabled).toBe(true);
  });

  test("replays more than 500 retained envelopes and applies a real runtime update", async () => {
    const retention = createLocalRetentionBuffer(1000);
    const receiver = await tryListen(
      buildApp(retention.buffer, { uiActions: true, retention }),
      0,
      "127.0.0.1",
    );
    try {
      // Initial metadata must precede replay, otherwise the viewer's default clips history.
      for (let index = 0; index < 501; index++)
        await sendEnvelope(receiver.port, `retained-${index}`);
      renderViewer(receiver.port, "/explorer/events");
      fireEvent.click(
        await screen.findByRole("button", { name: "Settings", exact: true }),
      );
      await screen.findByText(
        /501 envelopes currently retained/,
        {},
        { timeout: 10000 },
      );
      fireEvent.change(screen.getByLabelText("Retention limit"), {
        target: { value: "2000" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Apply retention limit" }),
      );
      await waitFor(() =>
        expect(
          (screen.getByLabelText("Retention limit") as HTMLInputElement).value,
        ).toBe("2000"),
      );
      expect(
        screen.getByText(/501 envelopes currently retained/),
      ).not.toBeNull();
      await waitFor(() =>
        expect(retention.getSettings()).toEqual({
          maxEnvelopes: 2000,
          retainedEnvelopes: 501,
        }),
      );
      await sendEnvelope(receiver.port, "after-growth");
      await screen.findByText(/502 envelopes currently retained/);
    } finally {
      cleanup();
      await stopReceiver(receiver.server);
    }
  }, 20000);

  test("updates live retention without clearing events or replacing the stream", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ maxEnvelopes: 1000, retainedEnvelopes: 2 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    renderBareViewer();
    const source = ControllableEventSource.instances[0];
    await act(async () => source?.onopen?.(new Event("open")));
    await act(async () => {
      source?.dispatchEvent(
        new MessageEvent("sentry.local.retention", {
          data: JSON.stringify({ maxEnvelopes: 500 }),
        }),
      );
      for (const id of ["one", "two"])
        source?.dispatchEvent(
          new MessageEvent(SENTRY_CONTENT_TYPE, {
            data: JSON.stringify([
              {},
              [[{ type: "event" }, { message: `retained ${id}` }]],
            ]),
            lastEventId: id,
          }),
        );
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Settings", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Retention limit"), {
      target: { value: "1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply retention limit" }),
    );
    await screen.findByText(
      /Cannot lower the limit below 2 retained envelopes/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Retention limit"), {
      target: { value: "1000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply retention limit" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () =>
      source?.dispatchEvent(
        new MessageEvent("sentry.local.retention", {
          data: JSON.stringify({ maxEnvelopes: 1000 }),
        }),
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Retention limit") as HTMLInputElement).value,
      ).toBe("1000"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Settings", exact: true }),
      ),
    );
    const clearButton = screen.getByRole("button", {
      name: "Clear events",
      exact: true,
    });
    fireEvent.focus(clearButton);
    await screen.findByRole("tooltip", { name: "Clear events", exact: true });
    fireEvent.blur(clearButton);
    expect(
      screen.getAllByRole("button", { name: "View event event" }),
    ).toHaveLength(2);
    expect(source?.closed).toBe(false);
    expect(ControllableEventSource.instances).toHaveLength(1);
  });

  test("requires reconnection before changing a disconnected receiver's retention", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();
    const source = ControllableEventSource.instances[0];
    await act(async () => {
      source?.onopen?.(new Event("open"));
      source?.dispatchEvent(
        new MessageEvent("sentry.local.retention", {
          data: '{"maxEnvelopes":1000}',
        }),
      );
      source?.dispatchEvent(
        new MessageEvent(SENTRY_CONTENT_TYPE, {
          data: JSON.stringify([
            {},
            [[{ type: "event" }, { message: "kept" }]],
          ]),
          lastEventId: "kept",
        }),
      );
      source?.onerror?.(new Event("error"));
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Settings", exact: true }),
    );
    await screen.findByText("Reconnect to this receiver to change retention.");
    expect(
      screen.queryByRole("button", { name: "Apply retention limit" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(
      screen.getByRole("button", { name: "View event event" }),
    ).not.toBeNull();
  });

  test("keeps closed retention read-only while its archive replay connects and opens", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(
      STREAM_STORAGE_KEY,
      "http://127.0.0.1:8969/_local/v1/sessions/closed-run/stream?cap=read",
    );
    renderBareViewer();
    const source = ControllableEventSource.instances[0]!;
    const retained = () =>
      new MessageEvent("sentry.local.session", {
        data: '{"state":"retained"}',
      });
    await act(async () => {
      source.onopen?.(new Event("open"));
      source.dispatchEvent(
        new MessageEvent("sentry.local.retention", {
          data: '{"maxEnvelopes":1000}',
        }),
      );
      source.dispatchEvent(retained());
    });
    await screen.findByRole("heading", { name: "Session closed" });
    fireEvent.click(
      screen.getByRole("button", { name: "Reload saved events" }),
    );
    const replay = ControllableEventSource.instances.at(-1)!;
    expect(replay).not.toBe(source);
    fireEvent.click(
      screen.getByRole("button", { name: "Settings", exact: true }),
    );
    const assertReadOnly = () => {
      expect(
        screen.getByText("Retention is read-only for closed sessions."),
      ).not.toBeNull();
      expect(screen.queryByLabelText("Retention limit")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Apply retention limit" }),
      ).toBeNull();
    };
    assertReadOnly();
    await act(async () => replay.onopen?.(new Event("open")));
    assertReadOnly();
    await act(async () => replay.dispatchEvent(retained()));
    assertReadOnly();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "ignores delayed retention responses after newer metadata (switch receiver: %s)",
    async (switchReceiver) => {
      ControllableEventSource.instances = [];
      vi.stubGlobal("EventSource", ControllableEventSource);
      let respond!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        respond = resolve;
      });
      const fetchMock = vi.fn().mockReturnValue(pending);
      vi.stubGlobal("fetch", fetchMock);
      renderBareViewer();
      let source = ControllableEventSource.instances[0];
      await act(async () => {
        source?.onopen?.(new Event("open"));
        source?.dispatchEvent(
          new MessageEvent("sentry.local.retention", {
            data: '{"maxEnvelopes":500}',
          }),
        );
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "Settings", exact: true }),
      );
      fireEvent.change(screen.getByLabelText("Retention limit"), {
        target: { value: "1" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Apply retention limit" }),
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      if (switchReceiver) {
        fireEvent.click(
          screen.getByRole("button", { name: "Close", exact: true }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));
        fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
          target: { value: "http://127.0.0.1:8970/stream" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));
        source = await openLatestReceiver();
      }
      await act(async () => {
        source?.onopen?.(new Event("open"));
        source?.dispatchEvent(
          new MessageEvent("sentry.local.retention", {
            data: '{"maxEnvelopes":1000}',
          }),
        );
        respond(new Response('{"maxEnvelopes":1}', { status: 200 }));
        await pending;
      });
      if (switchReceiver)
        fireEvent.click(
          await screen.findByRole("button", { name: "Settings", exact: true }),
        );
      await waitFor(() =>
        expect(
          (screen.getByLabelText("Retention limit") as HTMLInputElement).value,
        ).toBe("1000"),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Close", exact: true }),
      );
      await act(async () => {
        for (const id of ["one", "two"])
          source?.dispatchEvent(
            new MessageEvent(SENTRY_CONTENT_TYPE, {
              data: JSON.stringify([
                {},
                [[{ type: "event" }, { message: id }]],
              ]),
              lastEventId: id,
            }),
          );
      });
      expect(
        screen.getAllByRole("button", { name: "View event event" }),
      ).toHaveLength(2);
    },
  );

  test.each(["close success", "close error", "clear error"])(
    "ignores stale %s after switching away and back to the same receiver",
    async (action) => {
      ControllableEventSource.instances = [];
      vi.stubGlobal("EventSource", ControllableEventSource);
      let respond!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        respond = resolve;
      });
      const fetchMock = vi.fn().mockReturnValue(pending);
      vi.stubGlobal("fetch", fetchMock);
      renderBareViewer();
      await act(async () =>
        ControllableEventSource.instances[0]?.onopen?.(new Event("open")),
      );
      async function connect(url: string) {
        fireEvent.click(
          screen.getAllByRole("button", { name: /^Add receiver/ })[0]!,
        );
        fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
          target: { value: url },
        });
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));
        return openLatestReceiver();
      }
      const firstUrl =
        "http://127.0.0.1:8969/_local/v1/sessions/first/stream?cap=read";
      const first = await connect(firstUrl);
      await act(async () =>
        first.dispatchEvent(
          new MessageEvent(SENTRY_CONTENT_TYPE, {
            data: JSON.stringify([
              {},
              [[{ type: "event" }, { message: "old event" }]],
            ]),
            lastEventId: "old-event",
          }),
        ),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name:
            action === "clear error"
              ? "Clear events"
              : "Close telemetry session",
        }),
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await connect("http://127.0.0.1:8970/stream");
      const current = await connect(firstUrl);
      await act(async () => {
        respond(
          new Response(null, {
            status: action === "close success" ? 204 : 403,
          }),
        );
        await pending;
      });
      expect(current.closed).toBe(false);
      expect(
        screen.queryByText("Could not close this telemetry session."),
      ).toBeNull();
      expect(
        screen.queryByText(
          "Cleared this viewer, but the receiver could not clear its retained session.",
        ),
      ).toBeNull();
      await act(async () =>
        current.dispatchEvent(
          new MessageEvent(SENTRY_CONTENT_TYPE, {
            data: JSON.stringify([
              {},
              [[{ type: "event" }, { message: "new event" }]],
            ]),
            lastEventId: "new-event",
          }),
        ),
      );
      expect(
        await screen.findByRole("button", { name: "View event event" }),
      ).not.toBeNull();
      expect(
        screen.queryByRole("heading", { name: "Connect a receiver" }),
      ).toBeNull();
    },
  );

  test.each([204, 403])(
    "handles scoped reset HTTP %s and closes a telemetry session",
    async (resetStatus) => {
      ControllableEventSource.instances = [];
      vi.stubGlobal("EventSource", ControllableEventSource);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: resetStatus }))
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      renderBareViewer();

      const initialSource = ControllableEventSource.instances[0];
      expect(initialSource).toBeDefined();
      await act(async () => initialSource?.onopen?.(new Event("open")));
      fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));

      const streamUrl =
        "http://127.0.0.1:8969/_local/v1/sessions/session-1/stream?cap=read-capability";
      fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
        target: { value: streamUrl },
      });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      const scopedSource = await openLatestReceiver();
      await act(async () => {
        scopedSource?.dispatchEvent(
          new MessageEvent(SENTRY_CONTENT_TYPE, {
            data: JSON.stringify([{}, []]),
            lastEventId: "scoped-envelope",
          }),
        );
      });

      const clearButton = screen.getByRole("button", { name: "Clear events" });
      await waitFor(() =>
        expect((clearButton as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(clearButton);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:8969/_local/v1/sessions/session-1/ui/reset?cap=read-capability",
      );
      expect(fetchMock.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          signal: expect.any(AbortSignal),
        }),
      );
      if (resetStatus !== 204) {
        await screen.findByText(
          "Cleared this viewer, but the receiver could not clear its retained session.",
        );
      }

      fireEvent.click(
        screen.getByRole("button", { name: "Close telemetry session" }),
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        "http://127.0.0.1:8969/_local/v1/sessions/session-1/ui/close?cap=read-capability",
      );
      expect(fetchMock.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          signal: expect.any(AbortSignal),
        }),
      );
      await waitFor(() => expect(scopedSource?.closed).toBe(true));
      await screen.findByRole("heading", { name: "Session closed" });
      expect(
        screen.queryByText(
          "Telemetry session closed. Retained events remain available for three hours.",
        ),
      ).toBeNull();
      expect(screen.getByLabelText("Workspace navigation")).not.toBeNull();
      expect(screen.queryByLabelText("Receiver endpoint")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Reload saved events" }),
      ).not.toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Disconnect receiver" }),
      );
      await screen.findByRole("heading", { name: "Connect a receiver" });
      expect(
        screen.getByRole("region", { name: "Past connections" }),
      ).not.toBeNull();
      expect(screen.getByLabelText("Receiver endpoint")).not.toBeNull();
      await waitFor(() =>
        expect(
          screen.queryAllByLabelText("Connected to local receiver"),
        ).toHaveLength(0),
      );
    },
  );

  test("keeps retained raw envelopes accessible after the receiver fails", async () => {
    ControllableEventSource.instances = [];
    vi.stubGlobal("EventSource", ControllableEventSource);
    renderBareViewer();

    const source = ControllableEventSource.instances[0];
    expect(source).toBeDefined();
    await act(async () => source?.onopen?.(new Event("open")));
    await screen.findByText("Connected to local receiver");

    await act(async () => {
      source?.dispatchEvent(
        new MessageEvent(SENTRY_CONTENT_TYPE, {
          data: JSON.stringify([{}, []]),
          lastEventId: "raw-envelope-before-failure",
        }),
      );
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open envelopes view" }),
    );
    fireEvent.click(await screen.findByLabelText("View envelope event"));

    await act(async () => source?.onerror?.(new Event("error")));

    expect(screen.getByLabelText("Workspace navigation")).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Raw envelope" }),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Receiver endpoint")).toBeNull();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Search events" })[0]!,
    );
    fireEvent.change(screen.getByPlaceholderText("Search events and views"), {
      target: { value: "unmatched-envelope" },
    });
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("q")).toBe(
        "unmatched-envelope",
      ),
    );
    expect(screen.getByTestId("event-list").textContent).toContain(
      "No matching envelopes",
    );
  });

  test.each(["failed", "closed"])(
    "keeps retained search usable after the receiver is %s",
    async (state) => {
      ControllableEventSource.instances = [];
      vi.stubGlobal("EventSource", ControllableEventSource);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      );
      renderBareViewer();
      await act(async () =>
        ControllableEventSource.instances[0]?.onopen?.(new Event("open")),
      );
      fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));
      fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
        target: {
          value:
            "http://127.0.0.1:8969/_local/v1/sessions/retained/stream?cap=read",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      const source = await openLatestReceiver();
      await act(async () => {
        for (const transaction of ["GET /alpha", "GET /beta"]) {
          source?.dispatchEvent(
            new MessageEvent(SENTRY_CONTENT_TYPE, {
              data: JSON.stringify([
                {},
                [[{ type: "transaction" }, { transaction }]],
              ]),
              lastEventId: transaction,
            }),
          );
        }
      });
      await waitFor(() =>
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          2,
        ),
      );
      fireEvent.click(
        screen.getAllByRole("button", { name: "Search events" })[0]!,
      );
      fireEvent.change(screen.getByPlaceholderText("Search events and views"), {
        target: { value: "alpha" },
      });
      await waitFor(() =>
        expect(new URLSearchParams(window.location.search).get("q")).toBe(
          "alpha",
        ),
      );
      fireEvent.keyDown(
        screen.getByPlaceholderText("Search events and views"),
        { key: "Escape" },
      );
      if (state === "closed") {
        fireEvent.click(
          screen.getByRole("button", { name: "Close telemetry session" }),
        );
        await waitFor(() => expect(source?.closed).toBe(true));
        await screen.findByRole("heading", { name: "Session closed" });
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          1,
        );
        expect(
          screen.queryByRole("button", { name: "Close telemetry session" }),
        ).toBeNull();
        fireEvent.click(
          screen.getByRole("button", {
            name: "Reload saved events",
            exact: true,
          }),
        );
        const replay = await openLatestReceiver();
        await act(async () => replay.onerror?.(new Event("error")));
        expect(screen.getByRole("alert").textContent).toContain(
          "Could not connect to this receiver",
        );
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          1,
        );
      } else {
        await act(async () => source?.onerror?.(new Event("error")));
      }
      fireEvent.click(
        screen.getAllByRole("button", { name: "Search events" })[0]!,
      );
      fireEvent.change(screen.getByPlaceholderText("Search events and views"), {
        target: { value: "" },
      });
      await waitFor(() => {
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          2,
        );
        expect(new URLSearchParams(window.location.search).get("q")).toBeNull();
      });
    },
  );

  test("distinguishes empty trace searches from a receiver with no traces", async () => {
    const { server, port } = await startReceiver();
    try {
      await sendEnvelope(port, "GET /alpha", { traceId: "trace-alpha" });
      renderViewer(port, "/traces?q=missing");
      await screen.findByText("Connected to local receiver");
      await screen.findByRole("heading", { name: "No matching traces" });
      expect(screen.queryByText("No traces captured")).toBeNull();
      expect(
        screen.getByText(
          "Try a different search term or clear the search to see everything in this view.",
        ),
      ).not.toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("omits redundant type pills from dedicated Errors and Envelopes lists", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /broken", {
        type: "event",
        level: "error",
      });
      await screen.findByLabelText("View event event");

      fireEvent.click(screen.getByRole("button", { name: "Open errors view" }));
      expect(
        screen.getByLabelText("View event event").textContent,
      ).not.toContain("Error");

      fireEvent.click(
        screen.getByRole("button", { name: "Open envelopes view" }),
      );
      expect(
        screen.getByLabelText("View envelope event").textContent,
      ).not.toContain("envelope");
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("marks an error entry in the mixed event feed", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /broken", {
        type: "event",
        level: "error",
      });

      expect(
        (await screen.findByLabelText("View event event")).textContent,
      ).toContain("Error");
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("selects an event from the active workspace instead of retaining a live event", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /healthy");
      await sendEnvelope(port, "GET /broken", {
        type: "event",
        level: "error",
      });

      await screen.findByLabelText("View event event");
      fireEvent.click(screen.getByRole("button", { name: "Open errors view" }));

      expect(screen.getByTestId("event-detail").textContent).toContain(
        "/broken",
      );
      expect(screen.getByTestId("event-detail").textContent).not.toContain(
        "/healthy",
      );
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("filters retained events from the global command search", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /customers/42");
      await sendEnvelope(port, "POST /orders");

      await waitFor(() => {
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          2,
        );
      });
      fireEvent.click(
        screen.getAllByRole("button", { name: "Search events" })[0]!,
      );
      fireEvent.change(screen.getByPlaceholderText("Search events and views"), {
        target: { value: "customers" },
      });

      expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
        2,
      );
      expect(new URLSearchParams(window.location.search).get("q")).toBeNull();

      await waitFor(() => {
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          1,
        );
      });
      expect(screen.getByTestId("event-list").textContent).toContain(
        "/customers/42",
      );
      expect(screen.getByTestId("event-list").textContent).not.toContain(
        "/orders",
      );
      await waitFor(() => {
        expect(new URLSearchParams(window.location.search).get("q")).toBe(
          "customers",
        );
      });
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("keeps event detail within the active search filter", async () => {
    const { server, port } = await startReceiver();
    try {
      await sendEnvelope(port, "GET /unmatched-first");
      await sendEnvelope(port, "GET /matching-second");
      renderViewer(port, "/?q=matching-second");
      await screen.findByText("Connected to local receiver");
      await screen.findByLabelText("View transaction event");
      await waitFor(() => {
        expect(screen.getByTestId("event-detail").textContent).toContain(
          "/matching-second",
        );
        expect(screen.getByTestId("event-detail").textContent).not.toContain(
          "/unmatched-first",
        );
      });
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("clearing events also clears the global search for subsequent events", async () => {
    const { server, port } = await startReceiver();
    try {
      await sendEnvelope(port, "GET /old-search");
      renderViewer(port, "/?q=old-search");
      await screen.findByText("Connected to local receiver");
      await screen.findByLabelText("View transaction event");
      fireEvent.click(screen.getByRole("button", { name: "Clear events" }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      expect(new URLSearchParams(window.location.search).get("q")).toBeNull();
      await sendEnvelope(port, "GET /new-event");
      await screen.findByLabelText("View transaction event");
      expect(screen.getByTestId("event-detail").textContent).toContain(
        "/new-event",
      );
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("filters trace groups with global search while retaining their full waterfall", async () => {
    const { server, port } = await startReceiver();
    try {
      await sendEnvelope(port, "GET /alpha", { traceId: "trace-alpha" });
      await sendEnvelope(port, "GET /beta", {
        traceId: "trace-beta",
        spanId: "beta-span",
      });
      await sendEnvelope(port, "GET /related", {
        traceId: "trace-beta",
        spanId: "related-span",
      });
      renderViewer(port, "/traces?q=beta");
      await screen.findByText("Connected to local receiver");
      await screen.findByRole("button", { name: "View trace GET /beta" });
      expect(
        screen.queryByRole("button", { name: "View trace GET /alpha" }),
      ).toBeNull();
      expect(screen.getByLabelText("Trace waterfall").textContent).toContain(
        "/related",
      );
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("switching receivers isolates telemetry and selection from the previous stream", async () => {
    const first = await startReceiver();
    const second = await startReceiver();
    try {
      await sendEnvelope(first.port, "GET /session-a");
      await sendEnvelope(second.port, "GET /session-b");
      renderViewer(first.port);
      await screen.findByText("Connected to local receiver");
      await screen.findByLabelText("View transaction event");
      fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await screen.findByText("Connected to local receiver");
      expect(screen.getByTestId("event-list").textContent).toContain(
        "/session-a",
      );
      expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
        1,
      );
      fireEvent.click(screen.getByRole("button", { name: "Add receiver" }));
      fireEvent.change(screen.getByLabelText("Receiver endpoint"), {
        target: { value: `http://127.0.0.1:${second.port}/stream` },
      });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() => {
        expect(screen.getByTestId("event-list").textContent).toContain(
          "/session-b",
        );
        expect(screen.getByTestId("event-list").textContent).not.toContain(
          "/session-a",
        );
      });
      expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
        1,
      );
      expect(screen.getByTestId("event-detail").textContent).toContain(
        "/session-b",
      );
    } finally {
      cleanup();
      await stopReceiver(first.server);
      await stopReceiver(second.server);
    }
  });

  test("hydrates a shareable Explorer route and selected event from the URL", async () => {
    const { server, port } = await startReceiver();

    try {
      await sendEnvelope(port, "GET /other-error", {
        level: "error",
        type: "event",
      });
      await sendEnvelope(port, "GET /shared-error", {
        level: "error",
        type: "event",
      });

      renderViewer(port, "/errors");
      await screen.findByText("Connected to local receiver");
      await waitFor(() => {
        expect(screen.getAllByLabelText("View event event")).toHaveLength(2);
      });
      fireEvent.click(screen.getAllByLabelText("View event event")[1]!);
      const sharedEventId = await waitFor(() => {
        const eventId = new URLSearchParams(window.location.search).get(
          "event",
        );
        expect(eventId).not.toBeNull();
        return eventId!;
      });

      cleanup();
      renderViewer(port, `/errors?event=${encodeURIComponent(sharedEventId)}`);
      await screen.findByText("Connected to local receiver");
      await waitFor(() => {
        expect(screen.getAllByLabelText("View event event")).toHaveLength(2);
      });
      expect(
        screen
          .getByRole("button", { name: "Open errors view" })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(screen.getByTestId("event-detail").textContent).toContain(
        "/shared-error",
      );
      expect(screen.getByTestId("event-detail").textContent).not.toContain(
        "/other-error",
      );
      expect(new URLSearchParams(window.location.search).get("event")).toBe(
        sharedEventId,
      );
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("restores the prior selected event when browser history goes back", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /first");
      await sendEnvelope(port, "GET /second");

      await waitFor(() => {
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          2,
        );
      });
      const events = screen.getAllByLabelText("View transaction event");
      fireEvent.click(events[1]!);
      const selectedEventId = await waitFor(() => {
        const eventId = new URLSearchParams(window.location.search).get(
          "event",
        );
        expect(eventId).not.toBeNull();
        return eventId!;
      });
      expect(new URLSearchParams(window.location.search).get("event")).toBe(
        selectedEventId,
      );
      expect(screen.getByTestId("event-detail").textContent).toContain(
        "/second",
      );

      await act(async () => {
        window.history.back();
      });
      await waitFor(() => {
        expect(screen.getByTestId("event-detail").textContent).toContain(
          "/first",
        );
      });
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("opens a global command result in its shareable Explorer view", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /healthy");
      await sendEnvelope(port, "GET /broken", {
        type: "event",
        level: "error",
      });
      await screen.findByLabelText("View event event");

      fireEvent.click(
        screen.getAllByRole("button", { name: "Search events" })[0]!,
      );
      fireEvent.change(screen.getByPlaceholderText("Search events and views"), {
        target: { value: "broken" },
      });
      fireEvent.click(screen.getByRole("option", { name: /GET \/broken/i }));

      await waitFor(() => {
        expect(window.location.pathname).toBe("/errors");
        expect(
          new URLSearchParams(window.location.search).get("event"),
        ).not.toBeNull();
      });
      expect(screen.getByTestId("event-detail").textContent).toContain(
        "/broken",
      );

      await act(async () => {
        window.history.back();
      });
      await waitFor(() => {
        expect(
          screen
            .getByRole("button", { name: "Open live activity view" })
            .getAttribute("aria-current"),
        ).toBe("page");
      });
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("clears the local viewer feed from the sidebar", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /clear-me");
      await screen.findByLabelText("View transaction event");

      fireEvent.click(screen.getByRole("button", { name: "Clear events" }));

      expect(screen.queryByLabelText("View transaction event")).toBeNull();
      expect(screen.getByText("Waiting for events")).not.toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("summarizes related retained events in the trace waterfall", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /trace/first", { traceId: "shared-trace" });
      await sendEnvelope(port, "GET /trace/second", {
        traceId: "shared-trace",
      });

      await waitFor(() => {
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          2,
        );
      });

      const traceRelationship =
        await screen.findByLabelText("Trace relationship");
      expect(traceRelationship.textContent).toContain("2 captured items");
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("offers new events without interrupting the selected detail", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /selected");
      fireEvent.click(await screen.findByLabelText("View transaction event"));
      await sendEnvelope(port, "GET /new");

      await waitFor(() => {
        expect(screen.getAllByLabelText("View transaction event")).toHaveLength(
          2,
        );
      });

      expect(screen.getByTestId("event-detail").textContent).toContain(
        "GET /selected",
      );
      const newEvents = screen.getByRole("button", {
        name: "View 1 new event",
      });
      fireEvent.click(newEvents);

      expect(screen.getByTestId("event-detail").textContent).toContain(
        "GET /new",
      );
      expect(
        screen.queryByRole("button", { name: "View 1 new event" }),
      ).toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("keeps the event overview to non-repeated diagnostic details", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /summary", {
        operation: "http.server",
        startTimestamp: 1_699_999_999.99383,
        statusCode: 201,
        traceId: "summary-trace",
      });

      const details = await screen.findByRole("table", {
        name: "Event details",
      });
      expect(details.textContent).toContain("201");
      expect(details.textContent).toContain("6.17ms");
      expect(details.textContent).not.toContain("Method");
      expect(details.textContent).not.toContain("Route");
      expect(details.textContent).not.toContain("Trace ID");
      expect(details.textContent).not.toContain("Operation");
      expect(screen.getByTestId("event-detail").textContent).toContain(
        "GET /summary",
      );
      expect(screen.getByTestId("event-detail").textContent).toContain(
        "http.server",
      );

      fireEvent.click(screen.getByRole("button", { name: "Copy Status" }));
      expect(
        screen.getByRole("status", { name: "Status copied" }),
      ).not.toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("styles failing spans using their own telemetry", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /waterfall", {
        level: "error",
        statusCode: 500,
        operation: "http.server",
        spanId: "root-span",
        traceId: "waterfall-trace",
        startTimestamp: 1_699_999_999.988,
        spans: [
          {
            span_id: "db-span",
            parent_span_id: "root-span",
            op: "db.query",
            description: "SELECT * FROM orders",
            start_timestamp: 1_699_999_999.99,
            timestamp: 1_699_999_999.994,
          },
          {
            span_id: "http-span",
            parent_span_id: "root-span",
            op: "http.client",
            data: { "http.response.status_code": 503 },
            description: "GET https://inventory.test/items/42",
            start_timestamp: 1_699_999_999.995,
            timestamp: 1_699_999_999.998,
          },
        ],
      });

      expect(
        await screen.findByRole("region", { name: "Trace waterfall" }),
      ).not.toBeNull();
      expect(screen.getByRole("columnheader", { name: "Span" })).not.toBeNull();
      expect(
        screen.getByRole("columnheader", { name: "Timeline from 0ms to 12ms" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("columnheader", { name: "Duration" }),
      ).not.toBeNull();
      expect(screen.getByLabelText("Trace relationship").textContent).toContain(
        "1 captured item",
      );
      expect(screen.queryByLabelText("Trace summary")).toBeNull();
      expect(screen.getByText("db.query")).not.toBeNull();
      expect(screen.getByText("http.client")).not.toBeNull();
      expect(
        screen.getByRole("cell", { name: "Duration 4.00ms" }),
      ).not.toBeNull();
      expect(screen.getByTestId("waterfall-bar-root-span").className).toContain(
        "bg-red-500",
      );
      expect(
        screen.getByTestId("waterfall-bar-db-span").className,
      ).not.toContain("bg-red-500");
      expect(screen.getByTestId("waterfall-bar-http-span").className).toContain(
        "bg-red-500",
      );
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("groups trace records into one trace investigation", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /trace-parent", {
        operation: "http.server",
        spanId: "parent-span",
        traceId: "grouped-trace",
      });
      await sendEnvelope(port, "GET /trace-child", {
        operation: "db.query",
        spanId: "child-span",
        traceId: "grouped-trace",
      });

      fireEvent.click(screen.getByRole("button", { name: "Open traces view" }));

      expect(
        (await screen.findAllByRole("heading", { name: "Traces" })).length,
      ).toBeGreaterThan(0);
      expect(screen.getByText("1 trace")).not.toBeNull();
      const traceList = screen.getByLabelText("Trace list");
      expect(traceList.className).toContain("w-80");
      expect(traceList.className).toContain("bg-muted/30");

      const traceRow = screen.getByRole("button", {
        name: "View trace GET /trace-parent",
      });
      expect(traceRow.className).toContain("px-2");
      expect(traceRow.className).toContain("py-2");
      expect(traceRow.className).not.toContain("rounded-md");

      const waterfall = screen.getByRole("region", { name: "Trace waterfall" });
      expect(waterfall.parentElement?.className).not.toContain("p-4");
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("uses the active Explorer view label and gives empty views a useful explanation", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /broken", {
        type: "event",
        level: "error",
      });

      fireEvent.click(screen.getByRole("button", { name: "Open errors view" }));
      expect(
        await screen.findByRole("heading", { name: "Errors" }),
      ).not.toBeNull();
      expect(screen.getByText("1 error")).not.toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Open feedback view" }),
      );
      expect(
        await screen.findByRole("heading", { name: "No feedback received" }),
      ).not.toBeNull();
      expect(
        screen.getByText(
          "User feedback submitted through supported SDKs will appear here.",
        ),
      ).not.toBeNull();
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("moves between detail tabs with arrow keys", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);
      await screen.findByText("Connected to local receiver");
      await sendEnvelope(port, "GET /tabs");

      const overview = await screen.findByRole("tab", { name: "Overview" });
      fireEvent.keyDown(overview, { key: "ArrowRight" });

      expect(
        screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected"),
      ).toBe("true");
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });

  test("reserves space for the CLI logo", async () => {
    const { server, port } = await startReceiver();

    try {
      renderViewer(port);

      const logo = await screen.findByAltText("Sentry CLI");
      expect(logo.getAttribute("width")).toBe("117");
      expect(logo.getAttribute("height")).toBe("20");
    } finally {
      cleanup();
      await stopReceiver(server);
    }
  });
});
