/**
 * macOS/Bun can retain lingering handles after a command has finished its
 * work — keep-alive sockets, a fresh `/dev/tty` ReadStream, or a libuv
 * refcount quirk — keeping the event loop referenced so the process never
 * exits. This affects ordinary commands, not just the init wizard (see #1237,
 * #833).
 *
 * Schedule a force-exit safety net once the CLI's outer recovery middleware
 * has reached a terminal result. On macOS, an unref'd timer arms when the
 * exit telemetry flush settles. It only fires when another handle keeps the
 * event loop alive past a drained command, so it stays a no-op on clean exits
 * and never arms for commands that intentionally keep running (their awaited
 * work never resolves, so this is never reached).
 *
 * On every platform, the process exits when the flush does not settle in its
 * time limit. Open ingest requests would otherwise keep it alive, and on a
 * slow network the runtime metrics send new ones every 5 s.
 *
 * @param telemetryFlush - Resolves `true` when the exit telemetry flush
 *   settles, `false` when its time limit elapses first
 */
export function scheduleForceExit(
  telemetryFlush: Promise<boolean> = Promise.resolve(true),
): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  void telemetryFlush.then((settled) => {
    if (!settled) {
      exitAfterOutputDrains();
    } else if (process.platform === "darwin") {
      setTimeout(exitAfterOutputDrains, 100).unref();
    }
  });
}

/**
 * `process.exit()` drops stdout and stderr data that a pipe has not taken
 * yet, on Linux and macOS. Wait until both streams drain.
 */
function exitAfterOutputDrains(): void {
  const pending = [process.stdout, process.stderr].filter(
    (stream) => stream.writableLength > 0,
  );
  void Promise.all(
    pending.map(
      (stream) =>
        new Promise((resolve) => {
          stream.once("drain", resolve);
          stream.once("close", resolve);
        }),
    ),
  ).then(() => process.exit(process.exitCode ?? 0));
}
