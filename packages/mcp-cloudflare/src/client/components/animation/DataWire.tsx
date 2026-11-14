type DatarWireProps = {
  active?: boolean;
  direction?: "ltr" | "rtl";
  baseColorClass?: string; // solid wire color
  pulseColorClass?: string; // pulse highlight
  heightClass?: string; // Tailwind height, e.g. "h-1"
  periodSec?: number; // cycle duration
  pulseWidthPct?: number; // width of pulse %
  delaySec?: number; // NEW: delay before animation starts
  className?: string;
};

export default function DataWire({
  active = true,
  direction = "ltr",
  baseColorClass = "bg-white/0",
  pulseColorClass = "text-violet-400",
  heightClass = "h-0.5",
  periodSec = 0.5,
  pulseWidthPct = 100,
  delaySec = 0,
  className = "",
}: DatarWireProps) {
  return (
    <div
      className={[
        "wire w-full",
        heightClass,
        baseColorClass,
        pulseColorClass,
        active ? "" : "wire-paused",
        direction === "rtl" ? "wire-rtl" : "",
        className,
      ].join(" ")}
      style={{
        "--period": `${periodSec}s`,
        "--pulse-w": `${pulseWidthPct}%`,
        "--delay": `${delaySec}s`,
      }}
    />
  );
}
