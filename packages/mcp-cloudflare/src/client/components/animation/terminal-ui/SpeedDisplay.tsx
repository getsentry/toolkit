"use client";

import { ChevronsRight } from "lucide-react";
import { useEffect, useState } from "react";

type SpeedDisplayProps = {
  speed: number | string;
  /** total animation time; keep in sync with CSS via a CSS var */
  durationMs?: number;
  className?: string;
};

export default function SpeedDisplay({
  speed,
  durationMs = 500,
  className = "",
}: SpeedDisplayProps) {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    setAnimate(true);
    const t = setTimeout(() => setAnimate(false), durationMs);
    return () => clearTimeout(t);
  }, [speed, durationMs]);

  return (
    <div
      aria-live="polite"
      className={`absolute top-6 right-4 sm:top-8 sm:right-10 z-20 flex items-center font-bold text-xl sm:text-3xl opacity-50 ${
        animate ? "speed-animate" : ""
      } ${className}`}
      style={{ "--speed-pop-dur": `${durationMs}ms` }}
    >
      <div className="absolute right-0 top-0 -translate-y-full font-mono text-xs opacity-50 text-nowrap">
        sped up
      </div>
      <ChevronsRight className="size-6 sm:size-10 stroke-3" />
      {speed}x
    </div>
  );
}
