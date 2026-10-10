/** Domain inputs owned by the local file-change engine. */

/** One exact text replacement within an existing file. */
export type FileEdit = {
  /** Replacement text, converted to the target file's line endings. */
  newString: string;
  /** Unique exact text required in the current staged content. */
  oldString: string;
};

/** One prepared-batch input, normalized away from the legacy wire format. */
export type FileChange =
  | { action: "create"; content: string; path: string }
  | { action: "modify"; edits: FileEdit[]; path: string }
  | { action: "delete"; path: string };
