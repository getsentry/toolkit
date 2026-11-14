// The `codemod:ast-grep/langs/*` modules scripts/codemod.ts imports, as
// @codemod.com/jssg-types declares them in src/modules/langs.d.ts. That file
// is not exported on its own, and the package root, which references it,
// also loads declarations that fail to check (see tsconfig.json).
declare module "codemod:ast-grep/langs/javascript" {
  export { default } from "@codemod.com/jssg-types/langs/javascript";
}

declare module "codemod:ast-grep/langs/typescript" {
  export { default } from "@codemod.com/jssg-types/langs/typescript";
}

declare module "codemod:ast-grep/langs/tsx" {
  export { default } from "@codemod.com/jssg-types/langs/tsx";
}
