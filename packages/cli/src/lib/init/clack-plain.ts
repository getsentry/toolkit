/**
 * Plain-output adapter for @clack/prompts.
 *
 * When stdout is not a TTY (piped, redirected, CI), intercepts clack's
 * output functions and replaces them with clean plain-text alternatives.
 * Interactive prompts (select, confirm, multiselect) pass through to
 * real clack since they're only reached in TTY mode.
 *
 * The namespace import is load-bearing: existing tests spy on the
 * `@clack/prompts` module object via `spyOn(clack, 'cancel')`. Using
 * a namespace import here means `clack.cancel` resolves the same live
 * binding, so spies transparently intercept calls made through this
 * adapter. All re-exports delegate through the namespace object (not
 * captured bindings) so that `spyOn` replacements take effect.
 */

// biome-ignore lint/performance/noNamespaceImport: live binding required for test spyOn compatibility
import * as clack from "@clack/prompts";
import { isPlainOutput, stripAnsi } from "../formatters/plain-detect.js";

function plainWrite(message: string): void {
  process.stdout.write(`${stripAnsi(message)}\n`);
}

/** Plain-text log object matching clack's log interface. */
const plainLog: typeof clack.log = {
  info(message: string) {
    plainWrite(message);
  },
  warn(message: string) {
    plainWrite(`⚠ ${message}`);
  },
  warning(message: string) {
    plainWrite(`⚠ ${message}`);
  },
  error(message: string) {
    plainWrite(`✗ ${message}`);
  },
  success(message: string) {
    plainWrite(`✓ ${message}`);
  },
  message(message?: string) {
    if (message) {
      plainWrite(message);
    }
  },
  step(message: string) {
    plainWrite(message);
  },
};

function plainIntro(title?: string): void {
  if (title) {
    plainWrite(title);
  }
}

function plainOutro(message?: string): void {
  if (message) {
    plainWrite(message);
  }
}

function plainCancel(message?: string): void {
  if (message) {
    plainWrite(message);
  }
}

// Re-export with plain-output interception for output functions.
// Each wrapper checks isPlainOutput() at call time so env var changes
// (e.g. in tests) take effect immediately.

export const intro: typeof clack.intro = (...args) =>
  isPlainOutput() ? plainIntro(...args) : clack.intro(...args);

export const outro: typeof clack.outro = (...args) =>
  isPlainOutput() ? plainOutro(...args) : clack.outro(...args);

export const cancel: typeof clack.cancel = (...args) =>
  isPlainOutput() ? plainCancel(...args) : clack.cancel(...args);

/**
 * Log object that delegates to plain-text writers when output is plain,
 * or to real clack.log methods otherwise.
 *
 * Implemented as a Proxy so that every property access evaluates
 * `isPlainOutput()` fresh — no stale closure captures.
 */
export const log: typeof clack.log = new Proxy(clack.log, {
  get(target, prop: string) {
    if (isPlainOutput() && prop in plainLog) {
      return plainLog[prop as keyof typeof plainLog];
    }
    return target[prop as keyof typeof target];
  },
});

// Pass through interactive functions via thin wrappers that delegate
// through the namespace object. This preserves test spyOn compatibility:
// spyOn(clack, 'select') replaces the property on the module namespace,
// and these wrappers read from that namespace at call time.

export const select: typeof clack.select = (...args) => clack.select(...args);

export const confirm: typeof clack.confirm = (...args) =>
  clack.confirm(...args);

export const multiselect: typeof clack.multiselect = (...args) =>
  clack.multiselect(...args);

export const isCancel: typeof clack.isCancel = (
  value: unknown
): value is symbol => clack.isCancel(value);
