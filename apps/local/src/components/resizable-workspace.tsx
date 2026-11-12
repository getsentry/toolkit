import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

type ResizableWorkspaceProps = {
  list: ReactNode;
  children: ReactNode;
  storageKey: string;
  listLabel: string;
  initialWidth?: number;
};

const MIN_LIST_WIDTH = 256;
const MAX_LIST_WIDTH = 640;
const MIN_INSPECTOR_WIDTH = 320;
const SEPARATOR_WIDTH = 6;

/** Keep the inspector readable while allowing each list's width to follow the user. */
export function ResizableWorkspace({
  list,
  children,
  storageKey,
  listLabel,
  initialWidth = 352,
}: ResizableWorkspaceProps) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const [containerWidth, setContainerWidth] = useState(0);
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      const parsed = saved === null ? initialWidth : Number(saved);
      return Number.isFinite(parsed)
        ? Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, parsed))
        : initialWidth;
    } catch {
      return initialWidth;
    }
  });
  const maxWidth = Math.max(
    MIN_LIST_WIDTH,
    Math.min(
      MAX_LIST_WIDTH,
      containerWidth
        ? containerWidth - MIN_INSPECTOR_WIDTH - SEPARATOR_WIDTH
        : MAX_LIST_WIDTH,
    ),
  );
  const width = Math.max(MIN_LIST_WIDTH, Math.min(maxWidth, preferredWidth));
  const desktop =
    containerWidth === 0 ||
    containerWidth >= MIN_LIST_WIDTH + MIN_INSPECTOR_WIDTH + SEPARATOR_WIDTH;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () =>
      setContainerWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function resize(nextWidth: number) {
    const bounded = Math.max(MIN_LIST_WIDTH, Math.min(maxWidth, nextWidth));
    setPreferredWidth(bounded);
    try {
      localStorage.setItem(storageKey, String(bounded));
    } catch {
      // A browser storage policy must not prevent resizing the current view.
    }
  }

  return (
    <div
      ref={container}
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${desktop ? "md:flex-row" : ""}`}
      style={{ "--workspace-list-width": `${width}px` } as CSSProperties}
    >
      <aside
        aria-label={listLabel}
        className={`flex h-44 min-h-0 w-full shrink-0 flex-col overflow-hidden border-b border-border bg-muted/30 ${desktop ? "md:h-auto md:w-(--workspace-list-width) md:border-b-0" : ""}`}
      >
        {list}
      </aside>
      <div
        role="separator"
        aria-label={`Resize ${listLabel}`}
        aria-orientation="vertical"
        aria-valuemin={MIN_LIST_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        className={`hidden w-1.5 shrink-0 cursor-col-resize touch-none bg-border/60 outline-none hover:bg-primary/40 focus-visible:bg-primary/50 ${desktop ? "md:block" : ""}`}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 64 : 16;
          const next =
            event.key === "ArrowLeft"
              ? width - delta
              : event.key === "ArrowRight"
                ? width + delta
                : event.key === "Home"
                  ? MIN_LIST_WIDTH
                  : event.key === "End"
                    ? maxWidth
                    : undefined;
          if (next === undefined) return;
          event.preventDefault();
          resize(next);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width };
        }}
        onPointerMove={(event) => {
          if (drag.current)
            resize(drag.current.width + event.clientX - drag.current.x);
        }}
        onPointerUp={(event) => {
          drag.current = undefined;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-card">
        {children}
      </div>
    </div>
  );
}
