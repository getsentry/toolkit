// @vitest-environment-options {"url":"https://local.sentry.dev"}
import { createServer } from "node:net";
import { EventSource as NodeEventSource } from "eventsource";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NuqsAdapter } from "nuqs/adapters/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { BrowserRouter } from "react-router";
import { ThemeProvider } from "./components/theme-provider.tsx";
import { LocalWorkspaceRoute } from "./routes/local-workspace-route.tsx";
import { createLocalControlPlane } from "../../../packages/cli/src/commands/local/control-plane.ts";
import { tryListen } from "../../../packages/cli/src/commands/local/server.ts";
import {
  createLocalSessionStore,
  SESSION_RETENTION_MS,
} from "../../../packages/cli/src/commands/local/session-store.ts";
import App from "./App.tsx";

const headers = { Authorization: "Bearer session-switcher-test" };
async function startDaemon(now = Date.now) {
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  const port = address.port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const plane = createLocalControlPlane({
    controlToken: "session-switcher-test",
    host: "127.0.0.1",
    port,
    sessionStore: createLocalSessionStore({ now }),
  });
  const { server } = await tryListen(plane.app, port, "127.0.0.1");
  const create = async (label: string, maxEnvelopes = 500) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/_local/v1/sessions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          label,
          cwd: `/projects/${label}`,
          maxEnvelopes,
        }),
      },
    );
    return response.json() as Promise<{
      id: string;
      streamUrl: string;
      ingestUrl: string;
      directoryUrl: string;
    }>;
  };
  const ingest = async (
    session: { ingestUrl: string },
    transaction: string,
  ) => {
    expect(
      (
        await fetch(session.ingestUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-sentry-envelope" },
          body: `${JSON.stringify({ event_id: crypto.randomUUID() })}\n{"type":"transaction"}\n${JSON.stringify({ transaction })}\n`,
        })
      ).status,
    ).toBe(204);
  };
  return {
    plane,
    create,
    ingest,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
function renderSession(session: { streamUrl: string; directoryUrl?: string }) {
  window.history.replaceState(
    null,
    "",
    `/#${new URLSearchParams({ stream: session.streamUrl, ...(session.directoryUrl ? { directory: session.directoryUrl } : {}) })}`,
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
beforeEach(() => {
  render(<NuqsTestingAdapter>{null}</NuqsTestingAdapter>).unmount();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal("EventSource", NodeEventSource);
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

test("hosted viewer switches live sessions without mixing events and replays retained data", async () => {
  const daemon = await startDaemon();
  try {
    const web = await daemon.create("web");
    const worker = await daemon.create("worker", 1000);
    await daemon.ingest(web, "/web-request");
    await daemon.ingest(worker, "/worker-job");
    expect(window.location.origin).toBe("https://local.sentry.dev");
    renderSession(web);
    await screen.findAllByText("/web-request");
    const picker = await screen.findByRole("combobox", { name: "Session" });
    expect(window.location.hash).toBe("");
    expect(screen.queryByText("/worker-job")).toBeNull();
    fireEvent.change(picker, { target: { value: worker.id } });
    await screen.findAllByText("/worker-job");
    expect(screen.queryByText("/web-request")).toBeNull();
    await screen.findByText(/Retention limit: 1,000 envelopes/);
    expect(screen.queryByLabelText("Retention limit")).toBeNull();
    await daemon.ingest(web, "/web-after-switch");
    await daemon.ingest(worker, "/worker-after-switch");
    await screen.findAllByText("/worker-after-switch");
    expect(screen.queryByText("/web-after-switch")).toBeNull();
    fireEvent.change(picker, { target: { value: web.id } });
    await screen.findAllByText("/web-after-switch");
    await screen.findAllByText("/web-request");
    expect(screen.queryByText("/worker-job")).toBeNull();
    const api = await daemon.create("api");
    await screen.findByRole(
      "option",
      { name: /api.*Running/ },
      { timeout: 7000 },
    );
    daemon.plane.sessionStore.close(worker.id);
    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await screen.findByRole("option", { name: /worker.*Retained/ });
    fireEvent.change(picker, { target: { value: worker.id } });
    await screen.findAllByText("/worker-job");
    await screen.findAllByText("/worker-after-switch");
    expect(
      daemon.plane.sessionStore.getBuffer(web.id).read({ all: true }),
    ).toHaveLength(2);
    expect(
      daemon.plane.sessionStore.getBuffer(worker.id).read({ all: true }),
    ).toHaveLength(2);
    expect(daemon.plane.sessionStore.resolve(api.id).state).toBe("open");
    cleanup();
    renderSession({ streamUrl: worker.streamUrl });
    await screen.findByRole("combobox", { name: "Session" });
    await screen.findAllByText("/worker-job");
  } finally {
    cleanup();
    await daemon.stop();
  }
}, 15_000);

test("a discovery failure keeps the selected feed readable and can be retried", async () => {
  const daemon = await startDaemon();
  try {
    const web = await daemon.create("web");
    await daemon.ingest(web, "/still-readable");
    const directory = new URL(web.directoryUrl);
    directory.searchParams.set("cap", "expired");
    renderSession({ ...web, directoryUrl: directory.toString() });
    await screen.findAllByText("/still-readable");
    await screen.findByText(/Could not refresh sessions/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() =>
      expect(screen.getAllByText("/still-readable").length).toBeGreaterThan(0),
    );
    expect(
      daemon.plane.sessionStore.getBuffer(web.id).read({ all: true }),
    ).toHaveLength(1);
  } finally {
    cleanup();
    await daemon.stop();
  }
});

test("a scoped stream alone never enables sibling discovery", async () => {
  const daemon = await startDaemon();
  try {
    const web = await daemon.create("web");
    await daemon.ingest(web, "/scoped-only");
    renderSession({ streamUrl: web.streamUrl });
    await screen.findAllByText("/scoped-only");
    expect(screen.queryByRole("combobox", { name: "Session" })).toBeNull();
  } finally {
    cleanup();
    await daemon.stop();
  }
});

test("expired sessions disappear without clearing already displayed telemetry", async () => {
  let now = 1000;
  const daemon = await startDaemon(() => now);
  try {
    const web = await daemon.create("web");
    await daemon.ingest(web, "/retained-in-viewer");
    renderSession(web);
    await screen.findAllByText("/retained-in-viewer");
    await screen.findByRole("option", { name: /web.*Running/ });
    daemon.plane.sessionStore.close(web.id);
    now += SESSION_RETENTION_MS;
    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await screen.findByRole("option", { name: "No sessions available" });
    expect(screen.getAllByText("/retained-in-viewer").length).toBeGreaterThan(
      0,
    );
  } finally {
    cleanup();
    await daemon.stop();
  }
});
