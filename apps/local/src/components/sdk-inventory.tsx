import { sdkInventory } from "@/lib/inspection.ts";
import type { LocalFeedItem } from "@/lib/spotlight.ts";
export function SdkInventory({
  items,
  query = "",
}: {
  items: readonly LocalFeedItem[];
  query?: string;
}) {
  const entries = sdkInventory(items).filter((entry) =>
    `${entry.name} ${entry.version} ${entry.platform}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section
      aria-label="Connected SDKs"
      className="shrink-0 space-y-2 border-b border-border p-3"
    >
      <h2 className="text-sm font-semibold">Connected SDKs</h2>
      <p className="text-xs text-muted-foreground">
        SDK versions observed in this capture. Session and client reports appear
        below.
      </p>
      {entries.length ? (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-muted-foreground">
                {["SDK", "Version", "Platform", "Items", "Last seen"].map(
                  (label) => (
                    <th
                      key={label}
                      scope="col"
                      className="px-2 py-2 font-medium"
                    >
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={`${entry.name}@${entry.version}`}
                  className="border-t border-border"
                >
                  <td className="break-all px-2 py-2 font-mono">
                    {entry.name}
                  </td>
                  <td className="px-2 py-2">{entry.version}</td>
                  <td className="px-2 py-2">{entry.platform}</td>
                  <td className="px-2 py-2 tabular-nums">{entry.count}</td>
                  <td className="px-2 py-2">
                    {entry.lastSeen === undefined
                      ? "Unknown"
                      : String(entry.lastSeen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No matching SDK metadata captured.
        </p>
      )}
    </section>
  );
}
