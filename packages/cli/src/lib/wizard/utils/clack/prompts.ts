/**
 * The `@clack/prompts` functions the setup wizards use, gathered on one
 * object so the ported flows keep their `clack.log.info(…)` call sites.
 *
 * The wizards run only under `sentry wizard`, whose chunk loads on demand, so
 * importing clack here does not reach other commands or the completion bundle.
 *
 * `rawOutput` prints text the user copies as-is (code snippets, tokens):
 * outside clack's gutter, so nothing gets prefixed to the copied lines.
 *
 * Each member is a getter, so a test that mocks `@clack/prompts` with only
 * the functions its code path calls (as the sentry-wizard tests do) still
 * loads this module.
 */

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";

/** Print `value` to stdout on its own lines, outside clack's gutter. */
function rawOutput(value: string): void {
  process.stdout.write(`${value}\n`);
}

/** The clack prompts and log helpers the wizards call. */
export const clack = {
  get cancel() {
    return cancel;
  },
  get confirm() {
    return confirm;
  },
  get intro() {
    return intro;
  },
  get isCancel() {
    return isCancel;
  },
  get log() {
    return log;
  },
  get multiselect() {
    return multiselect;
  },
  get note() {
    return note;
  },
  get outro() {
    return outro;
  },
  rawOutput,
  get select() {
    return select;
  },
  get spinner() {
    return spinner;
  },
  get text() {
    return text;
  },
};
