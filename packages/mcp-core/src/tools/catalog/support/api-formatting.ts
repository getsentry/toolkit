import { isPlainObject } from "../../../internal/type-guards";

export { formatUnknown } from "../../../internal/unknown-formatting";

export function formatId(value: string | number | undefined | null): string {
  return value === undefined || value === null ? "unknown" : String(value);
}

export function formatDate(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString();
}

export function formatActor(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!isPlainObject(value)) {
    return "unknown";
  }

  const name = value.name;
  if (typeof name === "string" && name.trim()) {
    return name;
  }

  const email = value.email;
  if (typeof email === "string" && email.trim()) {
    return email;
  }

  const username = value.username;
  if (typeof username === "string" && username.trim()) {
    return username;
  }

  return formatId(
    typeof value.id === "string" || typeof value.id === "number"
      ? value.id
      : undefined,
  );
}

export function readString(
  value: Record<string, unknown> | undefined | null,
  key: string,
): string | null {
  if (!value) {
    return null;
  }

  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

export function compactLines(lines: Array<string | null | undefined | false>) {
  return lines.filter(
    (line): line is string =>
      line !== null && line !== undefined && line !== false,
  );
}
