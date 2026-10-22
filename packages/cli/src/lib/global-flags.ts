/**
 * Single source of truth for global CLI flags.
 *
 * Global flags are injected into every leaf command by {@link buildCommand}
 * and recognized at any argv position by Stricli's patched route scanner (a
 * top-level-flags allow-list). This module defines the metadata once so those
 * systems stay in sync automatically — adding a flag here is all that's needed.
 *
 * The Stricli flag *shapes* (kind, brief, default, etc.) remain in
 * `command.ts` because they depend on Stricli types and runtime values.
 * This module only stores the identity and argv-level behavior of each flag.
 */

/**
 * Behavior category for a global flag.
 *
 * - `"boolean"` — standalone toggle, supports `--no-<name>` negation
 * - `"value"` — consumes the next token (or `=`-joined value)
 */
type GlobalFlagKind = "boolean" | "value";

/** Metadata for a single global CLI flag. */
type GlobalFlagDef = {
  /** Long flag name without `--` prefix (e.g., `"verbose"`) */
  readonly name: string;
  /** Single-char short alias without `-` prefix, or `null` if none */
  readonly short: string | null;
  /** Whether this is a boolean toggle or a value-taking flag */
  readonly kind: GlobalFlagKind;
};

/**
 * All global flags that are injected into every leaf command.
 *
 * Order doesn't matter — both the `buildCommand` wrapper and the app-boundary
 * glue build lookup structures from this list.
 *
 * The set of flag tokens recognized *before the subcommand* is derived from
 * this list by {@link buildTopLevelFlags} and handed to Stricli's patched route
 * scanner via the `scanner.topLevelFlags` option (see `app.ts`). Adding or
 * removing a global flag here is all that's needed — the allow-list is no
 * longer hardcoded in the `@stricli/core` patch.
 */
export const GLOBAL_FLAGS: readonly GlobalFlagDef[] = [
  { name: "verbose", short: "v", kind: "boolean" },
  { name: "log-level", short: null, kind: "value" },
  { name: "json", short: null, kind: "boolean" },
  { name: "fields", short: null, kind: "value" },
  // Hidden compat shims: LLMs trained on the older sentry-cli generate
  // `--org` and `--project` flags. We silently accept them and map to
  // SENTRY_ORG / SENTRY_PROJECT env vars so the resolution chain handles them.
  // No short aliases: -p conflicts with release create's -p (--project).
  { name: "org", short: null, kind: "value" },
  { name: "project", short: null, kind: "value" },
];

/**
 * Allow-list of global flag tokens recognized before the subcommand, in the
 * shape consumed by Stricli's patched route scanner (`scanner.topLevelFlags`).
 *
 * - `booleanFlags` — tokens that stand alone (no value): each boolean flag's
 *   `--<name>`, its `-<short>` alias, and its `--no-<name>` negation.
 * - `valueFlags` — tokens that consume the following argv token (or an
 *   `=`-joined value) as their value: each value flag's `--<name>` and
 *   `-<short>` alias.
 *
 * The scanner uses these sets to forward a global flag placed before the
 * subcommand (`sentry --verbose issue list`) to the leaf command instead of
 * failing route resolution. Derived from {@link GLOBAL_FLAGS} so the two stay
 * in sync automatically.
 */
export type TopLevelFlags = {
  readonly booleanFlags: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
};

/**
 * Build the {@link TopLevelFlags} allow-list from {@link GLOBAL_FLAGS}.
 *
 * Passed to `buildApplication`'s `scanner.topLevelFlags` so the patched route
 * scanner recognizes these flags at any route depth.
 */
export function buildTopLevelFlags(): TopLevelFlags {
  const booleanFlags = new Set<string>();
  const valueFlags = new Set<string>();
  for (const flag of GLOBAL_FLAGS) {
    const target = flag.kind === "boolean" ? booleanFlags : valueFlags;
    target.add(`--${flag.name}`);
    if (flag.short !== null) {
      target.add(`-${flag.short}`);
    }
    if (flag.kind === "boolean") {
      booleanFlags.add(`--no-${flag.name}`);
    }
  }
  return { booleanFlags, valueFlags };
}
