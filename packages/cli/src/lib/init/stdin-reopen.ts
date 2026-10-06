/**
 * Workaround for a Bun single-file-binary issue where TTY fds inherited via
 * shell redirection (e.g. `curl | bash` → `exec "$sentry_bin" init </dev/tty`
 * in install.sh) report as TTYs and accept `setRawMode(true)` but never
 * deliver keypress events. A freshly-opened `/dev/tty` fd from inside the
 * process works correctly — so we open one and forward its data events onto
 * the existing `process.stdin` object that clack has already captured via
 * `import { stdin } from "node:process"`.
 *
 * We patch `process.stdin` in place rather than replacing it because
 * `Object.defineProperty(process, "stdin", ...)` does not propagate to the
 * `node:process` ESM binding (clack's `stdin` import is a snapshot of the
 * original object). But the original `process.stdin` object IS the same
 * reference clack holds, so patching listeners + setRawMode on it reaches
 * clack transparently.
 *
 * Platform scope: **macOS only (Bun 1.3.11).** PRs #824/#831/#833/#835
 * tracked this down: the original keystroke-delivery bug is FIXED on Linux
 * (verified via PTY harness mimicking install.sh's `exec bin </dev/tty`
 * flow), so `wizard-runner.ts` only installs this workaround when
 * `process.platform === "darwin"`. It comes with a side cost — opening a
 * second `tty.ReadStream` leaks a libuv handle that keeps the event loop
 * alive after the wizard completes (upstream oven-sh/bun#29126), so the
 * outer CLI pipeline pairs init with a
 * `setTimeout(process.exit, 100).unref()` safety net after recovery
 * middleware finishes.
 */

import { openSync } from "node:fs";
import { isatty, ReadStream } from "node:tty";

/**
 * Mutable subset of `process.stdin` that the TTY-forwarding workaround
 * temporarily patches while the init wizard is running.
 */
type StdinHandle = {
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
  pause: () => NodeJS.ReadStream;
  resume: () => NodeJS.ReadStream;
  _read: (size: number) => void;
};

/**
 * State captured when the init wizard installs fresh `/dev/tty` forwarding.
 * Stored so teardown can release the temporary TTY handle and restore
 * `process.stdin` to its original behavior.
 */
type InstalledState = {
  fresh: ReadStream;
  dataListener: (chunk: Buffer) => void;
  original: {
    setRawMode: StdinHandle["setRawMode"];
    pause: StdinHandle["pause"];
    resume: StdinHandle["resume"];
    read: StdinHandle["_read"];
  };
  /**
   * Value of `process.stdin.isTTY` before we touched it. Teardown restores
   * exactly this value rather than hardcoding `undefined`, so a concurrent
   * writer (e.g. another library that also backfills isTTY) doesn't get
   * silently stomped on.
   */
  previousIsTty: boolean | undefined;
  /** True when we wrote to `process.stdin.isTTY` at install time. */
  backfilledIsTty: boolean;
};

let installedState: InstalledState | null = null;

/**
 * Factory that returns a `/dev/tty` file descriptor. Overridable for tests
 * so we can exercise the install→teardown state transitions without depending
 * on the host's actual TTY.
 */
export type OpenTtyFactory = () => number;

/**
 * Predicate that reports whether fd 0 is a TTY. Overridable for tests
 * because `isatty(0)` reads real kernel state we can't mock easily — and
 * `bun test` runs with piped stdin where the predicate is always false.
 */
export type IsTtyPredicate = () => boolean;

/** Bundle of host primitives that tests can override. */
export type TtyDeps = {
  openTty?: OpenTtyFactory;
  isTty?: IsTtyPredicate;
};

const defaultOpenTty: OpenTtyFactory = () => openSync("/dev/tty", "r");
const defaultIsTty: IsTtyPredicate = () => isatty(0);

/**
 * Disposable returned by {@link forwardFreshTtyToStdin}. Calling
 * `[Symbol.dispose]()` — or equivalently letting a `using` declaration go
 * out of scope — releases the temporary TTY handle and restores
 * `process.stdin`. Always returned (never null) so callers don't need to
 * null-check inside `using` blocks.
 */
export type TtyForwardingHandle = Disposable;

/** Shared no-op disposable for the secondary-caller / already-installed case. */
const NOOP_HANDLE: TtyForwardingHandle = {
  [Symbol.dispose]: (): void => {
    // intentionally empty — primary caller owns teardown
  },
};

/**
 * Build a handle that routes disposal through
 * {@link closeFreshTtyForwarding}. Using the module-level function (rather
 * than a captured reference) preserves test observability — tests can spy
 * on `closeFreshTtyForwarding` and see it fire even on branches that didn't
 * install forwarding, matching the semantics of the pre-`using`
 * try/finally pattern. The underlying function is a no-op when
 * `installedState` is null, so extra calls are safe.
 */
function makeHandle(): TtyForwardingHandle {
  return {
    [Symbol.dispose]: (): void => {
      closeFreshTtyForwarding();
    },
  };
}

/**
 * Open a fresh `/dev/tty` fd and wire it up to feed `process.stdin`'s event
 * listeners.
 *
 * Always returns a {@link TtyForwardingHandle} (a `Disposable`) so callers
 * can use `using tty = forwardFreshTtyToStdin()` to guarantee teardown on
 * every exit path without null-checking. When no TTY is available or
 * `/dev/tty` can't be opened the disposable is a no-op by virtue of
 * `closeFreshTtyForwarding` short-circuiting on un-installed state — the
 * wizard still runs; non-interactive (`--yes`, piped stdin) flows stay as-is.
 *
 * Idempotent: repeated calls after the first successful install return a
 * pure no-op `Disposable` (the first caller owns teardown). Secondary
 * callers don't duplicate the data listener (which would cause clack to
 * receive each keystroke twice) or leak additional `/dev/tty` fds.
 *
 * @param deps - Optional dependency injection for tests. `openTty` overrides
 *   the `/dev/tty` factory; `isTty` overrides the `isatty(0)` predicate.
 *   Production callers pass no args — the defaults do the right thing.
 */
export function forwardFreshTtyToStdin(
  deps: TtyDeps = {}
): TtyForwardingHandle {
  const { openTty = defaultOpenTty, isTty = defaultIsTty } = deps;

  if (installedState) {
    // Another caller already installed forwarding and owns teardown. Hand
    // back a pure no-op so disposing the secondary handle does NOT call
    // `closeFreshTtyForwarding` — which would tear down the primary's
    // install before the primary's disposable fires.
    return NOOP_HANDLE;
  }
  if (!isTty()) {
    return makeHandle();
  }

  let fd: number;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    fd = openTty();
  } catch {
    return makeHandle();
  }

  const fresh = new ReadStream(fd);
  const stdinHandle = process.stdin as unknown as StdinHandle;
  const original = {
    setRawMode: stdinHandle.setRawMode,
    pause: stdinHandle.pause,
    resume: stdinHandle.resume,
    read: stdinHandle._read,
  };

  // Capture the current `isTTY` value before touching it so teardown can
  // restore it verbatim. Bun's compiled binary can leave
  // `process.stdin.isTTY === undefined` on inherited-via-redirect fds even
  // when `isatty(0)` is true. Clack gates its internal `setRawMode(true)`
  // call on `input.isTTY`, so without this backfill the patched setRawMode
  // below is never invoked and the fresh fd stays in canonical mode
  // (line-buffered, no keypresses).
  //
  // Use `Object.defineProperty` rather than plain assignment because on
  // some Node/Bun runtimes `process.stdin.isTTY` is defined as a
  // non-writable property (notably when stdin is not a TTY) — bare
  // `stdin.isTTY = …` throws a TypeError in strict mode in that case.
  const previousIsTty = process.stdin.isTTY;
  let backfilledIsTty = false;
  if (process.stdin.isTTY === undefined) {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    backfilledIsTty = true;
  }

  // Forward keystrokes from the working fd onto process.stdin so any
  // listeners clack attaches (readline's 'data', emitKeypressEvents'
  // 'keypress') fire as expected.
  const dataListener = (chunk: Buffer): void => {
    process.stdin.emit("data", chunk);
  };
  fresh.on("data", dataListener);

  // A ReadStream without an `error` listener crashes the process when it
  // emits (e.g. terminal disconnected, SSH dropped). The wizard can't
  // recover from a dead TTY, so silently drop — the next operation that
  // actually needs input will fail with a more meaningful error. The
  // listener stays attached across teardown intentionally: Bun can
  // asynchronously emit `'error'` (EBADF) after `destroy()` closes the
  // underlying fd, and an unhandled error on the stream crashes the
  // process. Keeping the listener attached absorbs any late emission.
  fresh.on("error", (): void => {
    // intentionally empty
  });

  // setRawMode issues a TCSETS ioctl on the underlying TTY device. The device
  // is shared between the broken fd 0 and the fresh fd, but the broken fd's
  // ioctl path may be the root cause — so route raw-mode toggles through the
  // fresh fd, which we know works.
  stdinHandle.setRawMode = (mode: boolean): NodeJS.ReadStream => {
    fresh.setRawMode(mode);
    return process.stdin;
  };

  // Prevent the stream machinery from touching the broken fd. Clack closes
  // each prompt with `input.unpipe()` and opens the next one by attaching
  // new listeners — that triggers Readable's `pause()`/`resume()` hooks,
  // which on Bun call kqueue against fd 0 and fail with EINVAL on the
  // second transition. We deliver bytes via `emit('data', …)` from the
  // fresh fd, so the fd-level flow machinery is dead weight here.
  const noop = (): NodeJS.ReadStream => process.stdin;
  stdinHandle.pause = noop;
  stdinHandle.resume = noop;
  stdinHandle._read = (_size: number): void => {
    // intentionally empty — see comment above
  };

  // Put the fresh stream into flowing mode so the OS delivers bytes to it and
  // our 'data' handler fires.
  fresh.resume();

  installedState = {
    fresh,
    dataListener,
    original,
    previousIsTty,
    backfilledIsTty,
  };

  return makeHandle();
}

/**
 * Tear down the fresh `/dev/tty` forwarding installed by
 * {@link forwardFreshTtyToStdin}.
 *
 * Must be safe on every wizard exit path, including when forwarding was never
 * installed. Destroying the temporary `ReadStream` releases the TTY handle so
 * the process can exit naturally once the wizard is done.
 *
 * Callers who opt into the {@link TtyForwardingHandle} `Disposable` API (via
 * `using tty = forwardFreshTtyToStdin()`) get this teardown for free — this
 * function exists for the imperative API and for explicit cleanup in tests.
 */
export function closeFreshTtyForwarding(): void {
  if (!installedState) {
    return;
  }

  const { fresh, dataListener, original, previousIsTty, backfilledIsTty } =
    installedState;
  installedState = null;

  fresh.off("data", dataListener);

  // Restore termios before destroying the fresh stream. If the wizard threw
  // mid-prompt (between clack's `setRawMode(true)` and its matching
  // `setRawMode(false)`), the TTY is still in raw mode — leaving it there
  // produces a shell with no echo after a crash. Best-effort: the fresh fd
  // may already be destroyed from a prior error, so swallow any throw.
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    fresh.setRawMode(false);
  } catch {
    // intentionally empty — stream already torn down
  }

  // Pause before destroy so no queued read callback tries to deliver bytes
  // after the stream has been torn down. The error listener installed at
  // setup time stays attached across destroy — see the comment at the
  // install site for why.
  fresh.pause();
  fresh.destroy();

  const stdinHandle = process.stdin as unknown as StdinHandle;
  stdinHandle.setRawMode = original.setRawMode;
  stdinHandle.pause = original.pause;
  stdinHandle.resume = original.resume;
  stdinHandle._read = original.read;

  // Release the libuv handle on fd 0. Clack's prompt lifecycle relies on
  // `rl.close() → rl.pause() → this.input.pause()` to pause stdin, but we
  // replaced `process.stdin.pause` with a no-op at install time (needed to
  // dodge Bun's fd-0 EINVAL on pause/resume transitions — see the comment
  // at the install site). So by the time we get here, stdin is still in
  // flowing/ref'd mode from `readline.createInterface()`'s internal
  // `input.resume()` — which keeps the libuv event loop alive indefinitely
  // after the wizard returns, manifesting as a post-wizard hang until the
  // user presses a key. Now that the original `.pause()` is restored,
  // invoke it directly so stock Node/Bun cleanup can finish. Idempotent:
  // safe when stdin was already paused.
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    original.pause.call(process.stdin);
  } catch {
    // Defensive: swallow errors from runtimes that throw if stdin is
    // already destroyed. This is end-of-lifecycle cleanup; nothing
    // downstream needs stdin.
  }

  if (backfilledIsTty) {
    Object.defineProperty(process.stdin, "isTTY", {
      value: previousIsTty,
      writable: true,
      configurable: true,
    });
  }
}
