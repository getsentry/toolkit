/**
 * macOS/Bun can retain lingering handles after a command has finished its
 * work — keep-alive sockets, a fresh `/dev/tty` ReadStream, or a libuv
 * refcount quirk — keeping the event loop referenced so the process never
 * exits. This affects ordinary commands, not just the init wizard (see #1237,
 * #833).
 *
 * Schedule a force-exit safety net once the CLI's outer recovery middleware
 * has reached a terminal result. The unref'd timer only fires when another
 * handle keeps the event loop alive past a drained command, so it stays a
 * no-op on clean exits and never arms for commands that intentionally keep
 * running (their awaited work never resolves, so this is never reached).
 */
export function scheduleForceExit(): void {
  if (process.platform === "darwin" && process.env.NODE_ENV !== "test") {
    setTimeout(() => {
      process.exit(process.exitCode ?? 0);
    }, 100).unref();
  }
}
