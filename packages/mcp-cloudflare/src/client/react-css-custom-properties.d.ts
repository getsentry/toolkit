import "react";

// Inline styles set CSS custom properties such as `--delay` for the
// animations; React's CSSProperties only lists standard properties.
declare module "react" {
  interface CSSProperties {
    // oxlint-disable-next-line typescript/consistent-indexed-object-style -- augmentation must merge into the existing interface
    [property: `--${string}`]: string | number | undefined;
  }
}
