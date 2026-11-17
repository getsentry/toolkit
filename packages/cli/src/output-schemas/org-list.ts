/**
 * Output schema building blocks of org-scoped lists: each item is the
 * entity with the `orgSlug` it came from.
 */

import {
  description,
  looseObject,
  object,
  type ObjectEntries,
  optional,
  pipe,
  string,
} from "valibot";

/** The field `withOrg` adds to each item of an org-scoped list. */
export const OrgListItemOutputFields = object({
  orgSlug: optional(pipe(string(), description("Organization slug"))),
});

/** Output schema of an org-scoped list item: the entity's, plus `orgSlug`. */
export function orgListItemSchema<TEntries extends ObjectEntries>(entity: {
  readonly entries: TEntries;
}) {
  return looseObject({
    ...entity.entries,
    ...OrgListItemOutputFields.entries,
  });
}
