import { afterEach, describe, expect, test, vi } from "vitest";

// Stub the post-exit installer spawn so teardown never launches a real process.
// `runInheritedCommand` only listens for "close"/"error", so a fake child that
// resolves "close" on the next microtask is enough to let disposal complete.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = {
        on(event: string, cb: () => void) {
          if (event === "close") {
            queueMicrotask(cb);
          }
          return child;
        },
      };
      return child as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});

const { InkUI } = await import("../../../../src/lib/init/ui/ink-ui.js");
const { WizardStore } = await import(
  "../../../../src/lib/init/ui/wizard-store.js"
);

function createUi(): {
  ui: InstanceType<typeof InkUI>;
  store: InstanceType<typeof WizardStore>;
} {
  const store = new WizardStore();
  const instance = {
    clear: vi.fn(),
    rerender: vi.fn(),
    unmount: vi.fn(),
    waitUntilExit: vi.fn().mockResolvedValue(undefined),
  };
  return { ui: new InkUI(instance, store, null), store };
}

function captureStdout(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InkUI teardown — installer handoff", () => {
  test("clears the screen and homes the cursor when a post-exit action is queued", async () => {
    const { ui, store } = createUi();
    // The completion screen queues this when the user opts into the plugin.
    store.queuePostExitAction("npx @sentry/ai install");
    const writes = captureStdout();

    await ui[Symbol.asyncDispose]();

    // Exiting the alt screen returns the cursor to where `sentry init` was
    // invoked (usually low on the screen). Clearing + homing after the exit
    // makes the installer's full-screen UI start at the top instead of
    // mid-screen with a blank gap above it.
    expect(writes.join("")).toContain("\x1b[?1049l\x1b[2J\x1b[H");
  });

  test("only restores the alt screen on a normal exit (no post-exit action)", async () => {
    const { ui } = createUi();
    const writes = captureStdout();

    await ui[Symbol.asyncDispose]();

    const joined = writes.join("");
    expect(joined).toContain("\x1b[?1049l");
    // No clear/home — the compact exit summary flows into the restored
    // scrollback at the invocation point, as before.
    expect(joined).not.toContain("\x1b[?1049l\x1b[2J\x1b[H");
  });
});
