import { stripAnsi } from "../../../../packages/cli/src/lib/formatters/strip-ansi.ts";
export type DetailField = { label: string; value: string; code?: boolean };

export function detailRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function attributeFields(value: unknown): DetailField[] {
  return Object.entries(detailRecord(value)).map(([label, attribute]) => {
    const record = detailRecord(attribute);
    const content = "value" in record ? record.value : attribute;
    return {
      label,
      // Display only: the JSON tab keeps SDK text exactly as captured.
      value:
        typeof content === "string"
          ? stripAnsi(content)
          : (JSON.stringify(content, (_key, nested: unknown) =>
              typeof nested === "string" ? stripAnsi(nested) : nested,
            ) ?? String(content)),
      code: true,
    };
  });
}
