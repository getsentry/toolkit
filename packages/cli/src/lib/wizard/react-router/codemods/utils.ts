/**
 * AST helpers shared by the React Router codemods.
 */

import type { namedTypes as t } from "ast-types";

export function getAfterImportsInsertionIndex(
  originalEntryServerModAST: t.Program,
): number {
  for (let x = originalEntryServerModAST.body.length - 1; x >= 0; x--) {
    if (originalEntryServerModAST.body[x]?.type === "ImportDeclaration") {
      return x + 1;
    }
  }

  return 0;
}
