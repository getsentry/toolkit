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

/** Supporting row rendered beneath a prompt title. */
export type PromptDetail = {
  /** Text displayed on its own row. */
  text: string;
  /** Semantic color treatment for the row. Defaults to `muted`. */
  tone?: "muted" | "success";
};

/** Args for {@link selectWithFilter} in `select-prompt.ts`. */
export type SelectOptions<T extends string> = {
  /** Prompt title shown above the choices. */
  message: string;
  /** Supporting rows rendered below the title; omitted by default. */
  details?: PromptDetail[];
  /** Explanatory copy rendered between details and actions; omitted by default. */
  footer?: PromptDetail;
  /** Choices presented to the user in display order. */
  options: SelectOption<T>[];
  /** Allow typing to filter entity choices by label, value, or hint. Defaults to false. */
  filterable?: boolean;
  /** Initially highlighted value. Defaults to the first option. */
  initialValue?: T;
};

/** The prompt the Ink sidecar renders, with its completion callback. */
export type SelectPrompt = {
  /** Prompt discriminator. */
  kind: "select";
  /** Prompt title shown above the choices. */
  message: string;
  /** Supporting rows rendered below the title; omitted by default. */
  details?: PromptDetail[];
  /** Explanatory copy rendered between details and actions; omitted by default. */
  footer?: PromptDetail;
  /** Choices presented to the user in display order. */
  options: SelectOption<string>[];
  /** Allow typing to filter this list of entities. Defaults to false. */
  filterable?: boolean;
  /** Zero-based option index highlighted when the prompt mounts. */
  initialIndex: number;
  /** Completes the prompt with a value, or `null` on cancellation. */
  resolve: (value: string | null) => void;
};
