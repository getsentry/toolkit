import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActivePrompt } from "../../../../src/lib/init/ui/wizard-store.js";

type SelectPrompt = Extract<ActivePrompt, { kind: "select" }>;

const { mountSelectPrompt, terminal } = vi.hoisted(() => ({
  mountSelectPrompt: vi.fn(),
  terminal: {
    isRaw: false,
    setRawMode: vi.fn(),
    pause: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn((...args: Parameters<typeof actual.openSync>) =>
      args[0] === "/dev/tty" ? 99 : actual.openSync(...args),
    ),
  };
});
vi.mock("node:tty", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:tty")>()),
  ReadStream: class {
    isRaw = terminal.isRaw;
    setRawMode = terminal.setRawMode;
    pause = terminal.pause;
    destroy = terminal.destroy;
  },
}));
vi.mock("../../../../src/lib/init/ui/ink-app.tsx", () => ({
  default: new URL("../../../../src/lib/init/ui/ink-app.tsx", import.meta.url)
    .pathname,
  mountSelectPrompt,
}));

import { selectWithFilter } from "../../../../src/lib/init/ui/ink-ui.js";

const OPTIONS = {
  message: "Select a project:",
  options: [
    { value: "frontend", label: "Web Application" },
    { value: "backend", label: "API Service" },
  ],
  initialValue: "backend",
};

let exit: () => void;
let instance: {
  clear: ReturnType<typeof vi.fn>;
  unmount: ReturnType<typeof vi.fn>;
  waitUntilExit: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  instance = {
    clear: vi.fn(),
    unmount: vi.fn(() => exit()),
    waitUntilExit: vi.fn(() => exited),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inline filterable select", () => {
  test("returns the choice and releases the prompt and terminal", async () => {
    mountSelectPrompt.mockImplementation((prompt: SelectPrompt) => {
      queueMicrotask(() => prompt.resolve("backend"));
      return instance;
    });

    await expect(selectWithFilter(OPTIONS)).resolves.toBe("backend");

    expect(mountSelectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: OPTIONS.message,
        options: OPTIONS.options,
        filterable: true,
        initialIndex: 1,
      }),
      { stdin: terminal, exitOnCtrlC: false, patchConsole: false },
    );
    expect(instance.clear).toHaveBeenCalledOnce();
    expect(instance.unmount).toHaveBeenCalledOnce();
    expect(terminal.setRawMode).toHaveBeenCalledWith(false);
    expect(terminal.destroy).toHaveBeenCalledOnce();
  });

  test("cancels on SIGINT and removes the handler after restoring the terminal", async () => {
    const initialHandlers = process.listeners("SIGINT");
    mountSelectPrompt.mockImplementation(() => {
      queueMicrotask(() => {
        // The test preload also handles SIGINT by exiting the worker.
        // Invoke only the picker listener so the harness remains alive.
        const cancel = process
          .listeners("SIGINT")
          .find((handler) => !initialHandlers.includes(handler));
        cancel?.();
      });
      return instance;
    });

    await expect(selectWithFilter(OPTIONS)).resolves.toBeNull();

    expect(process.listeners("SIGINT")).toEqual(initialHandlers);
    expect(terminal.setRawMode).toHaveBeenCalledWith(false);
    expect(terminal.destroy).toHaveBeenCalledOnce();
  });

  test("restores and closes the terminal when mounting fails", async () => {
    const error = new Error("Unable to mount picker");
    mountSelectPrompt.mockImplementation(() => {
      throw error;
    });

    await expect(selectWithFilter(OPTIONS)).rejects.toBe(error);

    expect(terminal.setRawMode).toHaveBeenCalledWith(false);
    expect(terminal.destroy).toHaveBeenCalledOnce();
  });
});
