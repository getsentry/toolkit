/**
 * An object from an Xcode project together with its id.
 */

export interface XcodeProjectObjectWithId<T> {
  id: string;
  obj: T;
  comment?: string | undefined;
}
