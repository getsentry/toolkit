import "react";

// Inline styles set CSS custom properties such as `--delay` for the
// animations; React's CSSProperties only lists standard properties.
declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
