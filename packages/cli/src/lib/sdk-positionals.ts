/**
 * Positional-argument packing for generated SDK methods.
 *
 * Lives in real source (rather than being emitted as a string by
 * `script/generate-sdk.ts`) so it is type-checked, linted, and testable on its own.
 *
 * @module
 */

/**
 * Positional arguments for a command that takes more than one, in declaration order.
 *
 * Trailing omissions are dropped so optional tail arguments stay optional, but an omission
 * in the middle becomes an empty string rather than disappearing - collapsing it would move
 * every later argument into the wrong slot and silently run a different command.
 */
export function positionals(...values: (string | undefined)[]): string[] {
  let end = values.length;
  while (end > 0 && values[end - 1] === undefined) {
    end -= 1;
  }
  return values.slice(0, end).map((value) => value ?? "");
}
