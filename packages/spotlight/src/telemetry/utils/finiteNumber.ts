/** Read numeric wire attributes without coercing blanks, booleans, or objects. */
export function finiteNumber(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !value.trim())
  ) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
