import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SelectPrompt } from "../../../src/lib/select-ui/types.js";

const { mountSelectPrompt, picker, terminal } = vi.hoisted(() => ({
  mountSelectPrompt: vi.fn(),
  picker: { close: vi.fn() },
  terminal: {
    isRaw: false,
    setRawMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    destroy: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
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
    resume = terminal.resume;
    pause = terminal.pause;
    destroy = terminal.destroy;
    once = terminal.once;
    removeListener = terminal.removeListener;
  },
}));
vi.mock("../../../src/lib/select-ui/picker.js", () => ({ mountSelectPrompt }));

import { selectWithFilter } from "../../../src/lib/select-ui/terminal.js";

const OPTIONS = {
  message: "Select a project:",
  options: [
    { value: "frontend", label: "Web Application" },
    { value: "backend", label: "API Service" },
  ],
  initialValue: "backend",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inline filterable select", () => {
  test("returns the choice and releases the prompt and terminal", async () => {
    mountSelectPrompt.mockImplementation((prompt: SelectPrompt) => {
      queueMicrotask(() => prompt.resolve("backend"));
      return picker;
    });

    await expect(selectWithFilter(OPTIONS)).resolves.toBe("backend");

    expect(mountSelectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: OPTIONS.message,
        options: OPTIONS.options,
        initialIndex: 1,
      }),
      {
        input: expect.objectContaining({ setRawMode: terminal.setRawMode }),
        output: process.stdout,
      },
    );
    expect(terminal.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(picker.close).toHaveBeenCalledOnce();
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(false);
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
        cancel?.("SIGINT");
      });
      return picker;
    });

    await expect(selectWithFilter(OPTIONS)).resolves.toBeNull();

    expect(process.listeners("SIGINT")).toEqual(initialHandlers);
    expect(terminal.setRawMode).toHaveBeenLastCalledWith(false);
    expect(terminal.destroy).toHaveBeenCalledOnce();
  });

  test("rejects when the terminal fails to read", async () => {
    const error = new Error("EIO");
    mountSelectPrompt.mockImplementation(() => {
      const [, onError] = terminal.once.mock.calls.find(
        ([event]) => event === "error",
      ) as [string, (error: unknown) => void];
      queueMicrotask(() => onError(error));
      return picker;
    });

    await expect(selectWithFilter(OPTIONS)).rejects.toBe(error);

    expect(picker.close).toHaveBeenCalledOnce();
    expect(terminal.destroy).toHaveBeenCalledOnce();
  });

  test("restores and closes the terminal when mounting fails", async () => {
    const error = new Error("Unable to mount picker");
    mountSelectPrompt.mockImplementation(() => {
      throw error;
    });

    await expect(selectWithFilter(OPTIONS)).rejects.toBe(error);

    expect(terminal.setRawMode).toHaveBeenLastCalledWith(false);
    expect(terminal.destroy).toHaveBeenCalledOnce();
  });
});
