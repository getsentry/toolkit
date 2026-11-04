/**
 * macOS/Bun can retain lingering handles after a command has finished its
 * work — keep-alive sockets, a fresh `/dev/tty` ReadStream, or a libuv
 * refcount quirk — keeping the event loop referenced so the process never
 * exits. This affects ordinary commands, not just the init wizard (see #1237,
 * #833).
 *
 * Schedule a force-exit safety net once the CLI's outer recovery middleware
 * has reached a terminal result. An unref'd timer arms when the exit
 * telemetry flush settles. It only fires when another handle keeps the event
 * loop alive past a drained command, so it stays a no-op on clean exits and
 * never arms for commands that intentionally keep running (their awaited work
 * never resolves, so this is never reached). Outside macOS, the timer is
 * longer: it only catches ingest responses that stall after their headers.
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
      return;
    }
    const lingerLimitMs =
      process.platform === "darwin"
        ? DARWIN_LINGER_LIMIT_MS
        : DEFAULT_LINGER_LIMIT_MS;
    setTimeout(exitAfterOutputDrains, lingerLimitMs).unref();
  });
}

const DARWIN_LINGER_LIMIT_MS = 100;
const DEFAULT_LINGER_LIMIT_MS = 1000;

/**
 * `process.exit()` drops stdout and stderr data that a pipe has not taken
 * yet, on Linux and macOS. Wait until both streams flush.
 *
 * `drain` fires only after a `write()` returned `false`, so data below the
 * high-water mark can stay pending without it. The callback of an empty write
 * runs after all earlier writes, or with an error when the stream is closed.
 */
function exitAfterOutputDrains(): void {
  const pending = [process.stdout, process.stderr].filter(
    (stream) => stream.writableLength > 0,
  );
  void Promise.all(
    pending.map(
      (stream) =>
        new Promise((resolve) => {
          stream.write("", resolve);
        }),
    ),
  ).then(() => process.exit(process.exitCode ?? 0));
}
