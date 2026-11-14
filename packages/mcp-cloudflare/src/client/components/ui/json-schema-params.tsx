function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDescription(property: unknown): string {
  return isObject(property) && typeof property["description"] === "string"
    ? property["description"]
    : "";
}

interface JsonSchemaParamsProps {
  schema: unknown;
  title?: string;
}

/**
 * Renders a standardized Parameters box from a JSON Schema-like object.
 * - Expects an object with a `properties` map; falls back to a flat key->description map.
 * - Returns null when there are no parameters to display.
 */
export default function JsonSchemaParams({
  schema,
  title = "Parameters",
}: JsonSchemaParamsProps) {
  let entries: Array<[string, unknown]> = [];

  if (isObject(schema) && "properties" in schema) {
    const props = schema["properties"];
    if (isObject(props)) {
      entries = Object.entries(props);
    }
  } else if (isObject(schema)) {
    entries = Object.entries(schema);
  }

  if (entries.length === 0) return null;

  return (
    <section className="rounded-md border border-slate-700/60 bg-black/30 p-3">
      <div className="text-xs uppercase tracking-wide text-slate-300/80 mb-1">
        {title}
      </div>
      <dl className="space-y-0">
        {entries.map(([key, property]) => (
          <div key={key} className="p-2 bg-black/20">
            <dt className="text-sm font-medium text-violet-300">{key}</dt>
            <dd className="text-sm text-slate-300 mt-0.5">
              {readDescription(property)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
