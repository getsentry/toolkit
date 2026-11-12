import {
  useMemo,
  useState,
  useRef,
  useEffect,
  type KeyboardEvent,
} from "react";
import type { LocalFeedItem } from "@/lib/spotlight.ts";
import type { TraceGroup } from "@/lib/trace-model.ts";
import {
  parseProfile,
  profileMatchesTrace,
  type ProfileNode,
} from "@/lib/profiles.ts";
import { record, text } from "@/lib/inspection.ts";
import { ResizableWorkspace } from "./resizable-workspace.tsx";
import { InspectorTabs } from "./span-detail.tsx";
import { Button } from "./ui/button.tsx";

type Box = {
  node: ProfileNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
};
function boxes(
  root: ProfileNode,
  type: "flame" | "treemap",
  width: number,
): Box[] {
  const result: Box[] = [];
  const pending: Box[] = [
    {
      node: root,
      x: 0,
      y: 0,
      width,
      height: type === "flame" ? 28 : 400,
      depth: 0,
    },
  ];
  while (pending.length && result.length < 2500) {
    const box = pending.pop()!;
    result.push(box);
    if (box.depth >= 32 || box.node.samples === 0) continue;
    let offset = 0;
    for (const child of box.node.children) {
      const fraction = child.samples / box.node.samples;
      const vertical = type === "treemap" && box.depth % 2 === 0;
      pending.push({
        node: child,
        x: vertical ? box.x + 2 : box.x + offset,
        y:
          type === "flame"
            ? box.y + 30
            : vertical
              ? box.y + 18 + offset
              : box.y + 18,
        width: vertical ? Math.max(0, box.width - 4) : box.width * fraction,
        height:
          type === "flame"
            ? 28
            : vertical
              ? Math.max(0, (box.height - 20) * fraction)
              : Math.max(0, box.height - 20),
        depth: box.depth + 1,
      });
      offset +=
        (vertical ? Math.max(0, box.height - 20) : box.width) * fraction;
    }
  }
  return result;
}
function color(node: ProfileNode): string {
  return node.inApp ? "#9b6b16" : node.id === "root" ? "#6655a7" : "#60657b";
}
function arc(
  inner: number,
  outer: number,
  start: number,
  end: number,
  center: number,
  centerY: number,
): string {
  const point = (r: number, angle: number) =>
    `${center + r * Math.cos(angle)},${centerY + r * Math.sin(angle)}`;
  const last = Math.min(end, start + Math.PI * 2 - 0.00001),
    large = last - start > Math.PI ? 1 : 0;
  return `M${point(outer, start)}A${outer},${outer} 0 ${large} 1 ${point(outer, last)}L${point(inner, last)}A${inner},${inner} 0 ${large} 0 ${point(inner, start)}Z`;
}
function ProfileChart({
  root,
  type,
  onSelect,
}: {
  root: ProfileNode;
  type: "flame" | "treemap" | "sunburst";
  onSelect: (node: ProfileNode) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => {
      if (element.clientWidth) setWidth(Math.max(288, element.clientWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layouts = boxes(root, type === "sunburst" ? "flame" : type, width);
  const radius = Math.min(200, (width - 8) / 2);
  const centerY = radius + 8;
  const depth = Math.max(1, ...layouts.map((box) => box.depth));
  const height =
    type === "flame"
      ? (depth + 1) * 30
      : type === "sunburst"
        ? 2 * radius + 16
        : 400;
  const activate = (event: KeyboardEvent<SVGGElement>, node: ProfileNode) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(node);
    }
  };
  return (
    <div ref={container} className="overflow-auto">
      <svg
        role="group"
        aria-label={`${type} profile visualization`}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full min-w-72"
      >
        <title>
          Sample distribution. Select a frame to zoom. App frames are gold;
          system frames are gray.
        </title>
        {layouts
          .filter((box) => box.width >= 1 && box.height >= 1)
          .map((box) => (
            <g
              key={box.node.id}
              role="button"
              tabIndex={0}
              aria-label={`Zoom to ${box.node.name}, ${box.node.samples} samples`}
              className="cursor-pointer outline-none focus:opacity-70"
              onClick={() => onSelect(box.node)}
              onKeyDown={(event) => activate(event, box.node)}
            >
              <title>{`${box.node.name}\n${box.node.location}\n${box.node.samples} inclusive samples; ${box.node.selfSamples} self samples`}</title>
              {type === "sunburst" ? (
                box.depth === 0 ? (
                  <circle
                    cx={width / 2}
                    cy={centerY}
                    r={radius / (depth + 1)}
                    fill={color(box.node)}
                    stroke="var(--background)"
                  />
                ) : (
                  <path
                    d={arc(
                      (box.depth * radius) / (depth + 1),
                      ((box.depth + 1) * radius) / (depth + 1),
                      (box.x / width) * Math.PI * 2 - Math.PI / 2,
                      ((box.x + box.width) / width) * Math.PI * 2 - Math.PI / 2,
                      width / 2,
                      centerY,
                    )}
                    fill={color(box.node)}
                    stroke="var(--background)"
                  />
                )
              ) : (
                <>
                  <rect
                    x={box.x}
                    y={box.y}
                    width={box.width}
                    height={box.height}
                    rx={1}
                    fill={color(box.node)}
                    stroke="var(--background)"
                  />
                  {box.width > 70 ? (
                    <text
                      x={box.x + 5}
                      y={box.y + 16}
                      fill="white"
                      fontSize={12}
                      pointerEvents="none"
                    >
                      {box.node.name.slice(0, Math.floor(box.width / 7) - 1)}
                    </text>
                  ) : null}
                </>
              )}
            </g>
          ))}
      </svg>
      <p className="text-xs text-muted-foreground">
        App frames: gold · System frames: gray · Select a frame to zoom. Charts
        show up to 32 levels and 2,500 nodes; the function table includes all
        parsed frames.
      </p>
    </div>
  );
}
function ProfileInspector({
  item,
  traces,
  onSelectTrace,
}: {
  item: LocalFeedItem;
  traces: readonly TraceGroup[];
  onSelectTrace: (id: string) => void;
}) {
  const [thread, setThread] = useState<string>();
  const [type, setType] = useState<"flame" | "treemap" | "sunburst">("flame");
  const [focus, setFocus] = useState<ProfileNode>();
  const [sort, setSort] = useState<"selfMs" | "totalMs" | "samples">("totalMs");
  const [filter, setFilter] = useState("");
  const profile = useMemo(() => parseProfile(item, thread), [item, thread]);
  const linked = traces.filter((trace) => profileMatchesTrace(item, trace));
  const functions = profile.functions
    .filter((fn) =>
      `${fn.name} ${fn.location}`.toLowerCase().includes(filter.toLowerCase()),
    )
    .toSorted((a, b) => b[sort] - a[sort]);
  const time = (value: number) =>
    profile.durationMs === undefined ? "—" : `${value.toFixed(2)} ms`;
  return (
    <InspectorTabs
      json={item.text}
      overview={
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">
              {item.type === "profile_chunk"
                ? "Continuous profile chunk"
                : "Profile"}
            </h2>
            <label className="text-xs">
              Thread{" "}
              <select
                className="ml-2 rounded border bg-background p-1"
                value={profile.threadId ?? ""}
                onChange={(event) => {
                  setThread(event.target.value);
                  setFocus(undefined);
                }}
              >
                {profile.threads.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} ({entry.id})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {profile.sampleCount.toLocaleString()} samples ·{" "}
            {profile.durationMs === undefined
              ? "Timing not captured"
              : `${profile.durationMs.toFixed(2)} ms observed`}
            . Time uses adjacent samples on the selected thread; the final
            sample has no inferred duration. Stacks are limited to 256 frames.
          </p>
          {linked.length ? (
            <div className="flex flex-wrap gap-2">
              {linked.map((trace) => (
                <Button
                  key={trace.id}
                  variant="outline"
                  className="h-auto max-w-full whitespace-normal break-words text-xs"
                  onClick={() => onSelectTrace(trace.id)}
                >
                  View trace · {trace.title}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No associated trace is available in this capture.
            </p>
          )}
          {profile.sampleCount && profile.functions.length ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs">
                  Visualization{" "}
                  <select
                    className="ml-2 rounded border bg-background p-1"
                    value={type}
                    onChange={(event) =>
                      setType(event.target.value as typeof type)
                    }
                  >
                    <option value="flame">Flame</option>
                    <option value="treemap">Treemap</option>
                    <option value="sunburst">Sunburst</option>
                  </select>
                </label>
                {focus ? (
                  <Button
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setFocus(undefined)}
                  >
                    Reset zoom
                  </Button>
                ) : null}
              </div>
              {focus ? (
                <p className="break-words font-mono text-xs">
                  {focus.name} · {focus.samples} samples · {focus.location}
                </p>
              ) : null}
              <ProfileChart
                root={focus ?? profile.root}
                type={type}
                onSelect={setFocus}
              />
              <label className="flex flex-wrap items-center gap-2 text-xs">
                Find function
                <input
                  type="search"
                  className="min-w-0 rounded border bg-background p-1"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              <div className="overflow-x-auto">
                <table
                  aria-label="Profile functions"
                  className="w-full text-left text-xs"
                >
                  <thead>
                    <tr>
                      <th scope="col" className="py-2">
                        Function
                      </th>
                      {(
                        [
                          ["selfMs", "Self time"],
                          ["totalMs", "Total time"],
                          ["samples", "Samples"],
                        ] as const
                      ).map(([key, label]) => (
                        <th
                          key={key}
                          scope="col"
                          aria-sort={sort === key ? "descending" : "none"}
                          className="px-2 py-2"
                        >
                          <button
                            type="button"
                            className="whitespace-nowrap"
                            onClick={() => setSort(key)}
                          >
                            {label}
                            {sort === key ? " ↓" : ""}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {functions.map((fn) => (
                      <tr key={fn.id} className="border-t border-border">
                        <th
                          scope="row"
                          className="max-w-72 break-words py-2 pr-2 text-left font-normal"
                        >
                          <span className="font-mono">{fn.name}</span>
                          <span className="block break-all text-muted-foreground">
                            {fn.location}
                          </span>
                        </th>
                        <td className="px-2 tabular-nums">{time(fn.selfMs)}</td>
                        <td className="px-2 tabular-nums">
                          {time(fn.totalMs)}
                        </td>
                        <td className="px-2 tabular-nums">{fn.samples}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              No usable stack samples were captured. Inspect JSON for the
              original profile payload.
            </p>
          )}
        </>
      }
    />
  );
}
export function ProfileWorkspace({
  items,
  traces,
  query,
  selectedId,
  onSelect,
  onSelectTrace,
}: {
  items: readonly LocalFeedItem[];
  traces: readonly TraceGroup[];
  query: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  onSelectTrace: (id: string) => void;
}) {
  const profiles = items.filter((item) =>
    item.text.toLowerCase().includes(query.toLowerCase()),
  );
  const selected =
    profiles.find((item) => item.id === selectedId) ?? profiles[0];
  if (!selected)
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        {query
          ? "No profiles match this filter."
          : "No profiles captured. Enable profiling in your SDK and send its envelopes to this receiver."}
      </p>
    );
  return (
    <ResizableWorkspace
      storageKey="sentry.local.profile-width"
      listLabel="Profiles"
      list={
        <section className="flex min-h-0 flex-1 flex-col">
          <h1 className="shrink-0 border-b border-border p-3 text-sm font-semibold">
            Profiles · {profiles.length}
          </h1>
          <ol className="min-h-0 flex-1 overflow-y-auto">
            {profiles.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-label={`View ${item.type} event`}
                  aria-current={selected.id === item.id ? "true" : undefined}
                  className="w-full border-b border-border p-3 text-left text-sm hover:bg-muted aria-current:bg-muted"
                  onClick={() => onSelect(item.id)}
                >
                  <span className="block">
                    {item.type === "profile_chunk" ? "Chunk" : "Profile"}{" "}
                    {index + 1} ·{" "}
                    {text(record(item.payload).platform) ?? "Unknown platform"}
                  </span>
                  <code className="block break-all text-xs text-muted-foreground">
                    {text(record(item.payload).event_id) ??
                      text(record(item.payload).chunk_id) ??
                      item.id}
                  </code>
                </button>
              </li>
            ))}
          </ol>
        </section>
      }
    >
      <ProfileInspector
        key={selected.id}
        item={selected}
        traces={traces}
        onSelectTrace={onSelectTrace}
      />
    </ResizableWorkspace>
  );
}
