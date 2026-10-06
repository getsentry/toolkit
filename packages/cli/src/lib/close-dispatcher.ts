/**
 * Node's global `fetch` (undici) keeps a pool of keep-alive sockets open after
 * a command finishes its work. Those sockets keep the event loop referenced,
 * so the process lingers instead of exiting on its own (see #1237).
 *
 * Destroying the global dispatcher releases the pooled sockets, letting the
 * loop drain naturally. This is the root-cause complement to the force-exit
 * timer, which stays armed as a last-resort backstop.
 *
 * `destroy()` aborts in-flight requests and returns immediately rather than
 * waiting for them to settle, so it can't hang the exit path. The call runs in
 * a `finally` after the command has already produced its result, so it must
 * never reject — a shutdown error here would otherwise mask the command's
 * outcome and skip the backstop timer.
 */
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

type ClosableDispatcher = { destroy?: () => Promise<void> };

export async function closeGlobalDispatcher(): Promise<void> {
  const dispatcher = (globalThis as Record<PropertyKey, unknown>)[
    GLOBAL_DISPATCHER
  ] as ClosableDispatcher | undefined;

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    await dispatcher?.destroy?.();
  } catch {
    // Socket teardown errors are irrelevant once we're on the way out.
  }
}
