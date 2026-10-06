import "vitest";

declare module "vitest" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: interface required for vitest module augmentation
  interface Assertion<T> {
    toStartWith(expected: string): T;
    toEndWith(expected: string): T;
    toBeString(): T;
    toBeArray(): T;
  }
  // biome-ignore lint/style/useConsistentTypeDefinitions: interface required for vitest module augmentation
  interface AsymmetricMatchersContaining {
    toStartWith(expected: string): unknown;
    toEndWith(expected: string): unknown;
    toBeString(): unknown;
    toBeArray(): unknown;
  }
}
