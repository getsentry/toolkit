import "vitest";

declare module "vitest" {
  // interface required for vitest module augmentation; asymmetric
  // matchers (`expect.toBeString()`) extend Matchers and pick these up
  interface Matchers<R, T> {
    toStartWith(expected: string): R;
    toEndWith(expected: string): R;
    toBeString(): R;
    toBeArray(): R;
  }
}
