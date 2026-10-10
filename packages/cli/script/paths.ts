/**
 * Shared path constants for build/generate/check scripts.
 *
 * These scripts run with the CWD set to this package root (`packages/cli/`).
 * The documentation site lives in a sibling workspace package
 * (`apps/cli-docs/`), so cross-package paths are resolved relative to this
 * package root. Centralizing the docs root here keeps the monorepo layout in
 * one place instead of scattering `../../apps/cli-docs` literals across scripts.
 */

/** Docs site package root, relative to this package (`packages/cli/`). */
export const DOCS_ROOT = "../../apps/cli-docs";

/** Docs content/source directories, relative to this package. */
export const DOCS_SRC = `${DOCS_ROOT}/src`;
export const DOCS_CONTENT = `${DOCS_SRC}/content/docs`;
export const DOCS_FRAGMENTS = `${DOCS_SRC}/fragments`;
export const DOCS_PUBLIC = `${DOCS_ROOT}/public`;
