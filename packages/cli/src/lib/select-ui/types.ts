/**
 * Types for the fuzzy-filter select picker.
 *
 * `select-prompt.ts` takes {@link SelectOptions} from callers; `ink-ui.ts`
 * turns them into a {@link SelectPrompt} that the Ink sidecar
 * (`ink-app.tsx`) renders.
 */

/** Single option in a select prompt. */
export type SelectOption<T extends string> = {
  /** Machine-readable value returned when the user chooses this option. */
  value: T;
  /** User-facing option label. */
  label: string;
  /** Optional secondary copy rendered beside the label; omitted by default. */
  hint?: string;
};

/** Args for `selectWithFilter` in `select-prompt.ts`. */
export type SelectOptions<T extends string> = {
  /** Prompt title shown above the choices. */
  message: string;
  /** Choices presented to the user in display order. Typing filters them. */
  options: SelectOption<T>[];
  /** Initially highlighted value. Defaults to the first option. */
  initialValue?: T;
};

/** The prompt the Ink sidecar renders, with its completion callback. */
export type SelectPrompt = {
  /** Prompt title shown above the choices. */
  message: string;
  /** Choices presented to the user in display order. */
  options: SelectOption<string>[];
  /** Zero-based option index highlighted when the prompt mounts. */
  initialIndex: number;
  /** Completes the prompt with a value, or `null` on cancellation. */
  resolve: (value: string | null) => void;
};
