/** Required lazily by `lazy.ts`. Its own `.js` import must map to `leaf.ts`. */
import { LEAF } from "./leaf.js";

export function describeTarget(): string {
  return `target of ${LEAF}`;
}
