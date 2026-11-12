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
      value:
        typeof content === "string"
          ? content
          : (JSON.stringify(content) ?? String(content)),
      code: true,
    };
  });
}
