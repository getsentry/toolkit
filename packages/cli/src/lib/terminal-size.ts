/**
 * Terminal size reads that keep Node's "not a TTY" case.
 *
 * Node types `process.stdout.columns` and `rows` as numbers, but leaves them
 * undefined when stdout is piped. A real `0` stays `0`.
 */

type MaybeTtySize = { readonly columns?: number; readonly rows?: number };

/** Width of stdout in columns, or `fallback` when stdout is not a TTY. */
export function stdoutColumns(
  fallback: number,
  stream: MaybeTtySize = process.stdout,
): number {
  return stream.columns ?? fallback;
}

/** Height of stdout in rows, or `fallback` when stdout is not a TTY. */
export function stdoutRows(
  fallback: number,
  stream: MaybeTtySize = process.stdout,
): number {
  return stream.rows ?? fallback;
}
