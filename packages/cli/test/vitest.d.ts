import "vitest";

declare module "vitest" {
  // interface required for vitest module augmentation
  interface Assertion<T> {
    toStartWith(expected: string): T;
    toEndWith(expected: string): T;
    toBeString(): T;
    toBeArray(): T;
  }
  // interface required for vitest module augmentation
  interface AsymmetricMatchersContaining {
    toStartWith(expected: string): unknown;
    toEndWith(expected: string): unknown;
    toBeString(): unknown;
    toBeArray(): unknown;
  }
}
