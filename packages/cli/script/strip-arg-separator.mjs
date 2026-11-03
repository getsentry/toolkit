/**
 * Preload for the dev CLI scripts (`pnpm run cli`, `pnpm run dev`).
 *
 * npm needs `npm run cli -- --help` to forward arguments, but pnpm and Yarn
 * forward the `--` too, so the CLI would see `-- --help` and treat `--help` as
 * a positional. A leading `--` is never meaningful to the CLI itself, so drop
 * it and let either habit work with any package manager.
 *
 * Dev scripts only; the built binary keeps its arguments unchanged.
 */

if (process.argv[2] === "--") {
  process.argv.splice(2, 1);
}
