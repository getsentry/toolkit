"use client";
import { useEffect, useState } from "react";

export default function RootCause({ step }: { step: number }) {
  const [started, setStarted] = useState(false);
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    if (step === 2) {
      setStarted(false);
      setRunId((n) => n + 1);
      const t = setTimeout(() => setStarted(true), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [step]);

  const orange = "#ff8904";
  const randomBaseColor = "#fff8";
  const pulseColor = orange;
  const flickerBright = "#fffc";

  // Grid + content
  const cols = 21;
  const rows = cols;
  const total = cols * rows;
  const centerText = "root cause";
  const middleRow = Math.floor(rows / 2);
  const startCol = Math.floor((cols - centerText.length) / 2);
  const startIdx = middleRow * cols + startCol;

  const pool = "!@#$%^&*(){}[]<>?/\\|~`+=-:;.,\"'";
  const items = Array.from({ length: total }, (_, idx) =>
    idx >= startIdx && idx < startIdx + centerText.length
      ? centerText[idx - startIdx]
      : pool[Math.floor(Math.random() * pool.length)],
  );

  const originX = cols / 2;
  const originY = 0;
  const sweepMs = 900;
  const globalDelayMs = 900;

  // globe depth
  const centerX = (cols - 1) / 2;
  const centerY = (rows - 1) / 2;
  const maxDistance = Math.sqrt(centerX * centerX + centerY * centerY);
  const maxScaleReduction = 0.35;
  const translateStrength = 12;
  const opacityFalloff = 0.7;
  const radius = Math.min(centerX, centerY) - 0.6;

  // Anim cfg
  const cellPulseMs = 220;

  const scanning = started;
  const centerHighlighted = started;

  return (
    <div
      key={runId}
      className="grid absolute left-1/2 -translate-x-[calc(50%)] gap-0 w-full font-mono aspect-square translate-y-10"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        fontSize: "1.25rem",
        lineHeight: 1,
        borderRadius: "50%",
        overflow: "hidden",
      }}
    >
      <style>{`
          @keyframes scannerPulse {
            0%   { color: var(--start-color); transform: scale(1); text-shadow: none; }
            40%  { color: var(--pulse-color); transform: scale(1.22); text-shadow: 0 0 8px var(--pulse-color); }
            100% { color: var(--end-color);   transform: scale(1); text-shadow: none; }
          }
          @keyframes preFlicker {
            0%   { color: var(--start-color); text-shadow: none; }
            50%  { color: var(--flicker-color); text-shadow: 0 0 4px var(--flicker-color); }
            100% { color: var(--start-color); text-shadow: none; }
          }
        `}</style>

      {items.map((ch, i) => {
        const isCenter = i >= startIdx && i < startIdx + centerText.length;
        const row = Math.floor(i / cols);
        const col = i % cols;

        // Sweep delay per cell: left -> right (angle) + slight radial bias
        const dx = col + 0.5 - originX;
        const dy = row + 0.5 - originY;
        const angle = Math.atan2(dx, dy);
        const normalized = (angle + Math.PI / 2) / Math.PI; // 0..1
        const distance = Math.sqrt(dx * dx + dy * dy);
        const radialOffset = Math.min(200, distance * 14);
        const sweepDelayMs = Math.round(normalized * sweepMs + radialOffset);
        const effectiveSweepDelay = globalDelayMs + sweepDelayMs;

        // Depth transform
        const toCenterX = centerX - col;
        const toCenterY = centerY - row;
        const distToCenter = Math.sqrt(
          toCenterX * toCenterX + toCenterY * toCenterY,
        );
        const sphereFactor = Math.min(1, distToCenter / maxDistance);
        const outsideCircle = distToCenter > radius;

        const baseScale = isCenter
          ? centerHighlighted
            ? 1.06
            : 0.98
          : scanning
            ? 1.04
            : 0.96;
        const sphereScaleMultiplier = 1 - maxScaleReduction * sphereFactor;
        const finalScale = +(baseScale * sphereScaleMultiplier).toFixed(3);
        const tx = +(toCenterX * translateStrength * sphereFactor).toFixed(1);
        const ty = +(toCenterY * translateStrength * sphereFactor).toFixed(1);

        const opacityActive = Math.max(0.15, 1 - opacityFalloff * sphereFactor);
        const opacityInactive = Math.max(0.03, 0.18 - 0.12 * sphereFactor);

        let opacity: number;
        if (outsideCircle) {
          opacity = 0;
        } else if (centerHighlighted) {
          opacity = isCenter ? 1 : 0.25;
        } else {
          opacity = scanning ? opacityActive : opacityInactive;
        }

        const displayedChar = outsideCircle ? "" : ch;

        let flickerAnim = "";
        if (started && !isCenter && effectiveSweepDelay > 80) {
          const safety = 80;
          const budget = Math.max(0, effectiveSweepDelay - safety);
          const dur = 450 + Math.floor(Math.random() * 500);
          const cycles = Math.max(1, Math.floor(budget / dur));
          const adjustedDur =
            cycles === 1 ? Math.max(220, Math.min(budget, dur)) : dur;
          flickerAnim = `, preFlicker ${adjustedDur}ms ease-in-out 0ms ${cycles} alternate`;
        }

        const scannerAnim = scanning
          ? `scannerPulse ${cellPulseMs}ms linear ${effectiveSweepDelay}ms 1 forwards`
          : "none";

        const startColor = isCenter ? "#fff3" : randomBaseColor;
        const endColor = isCenter ? orange : randomBaseColor;

        const animationValue = scannerAnim + flickerAnim;

        return (
          <div
            key={`${row}-${col}`}
            className="flex items-center justify-center"
            style={{
              transition: "transform 300ms, opacity 300ms",
              width: "100%",
              height: "100%",
              transform: `translate(${tx}px, ${ty}px) scale(${
                outsideCircle ? 0.9 : finalScale
              })`,
              opacity,
              pointerEvents: outsideCircle ? "none" : "auto",
              textAlign: "center",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={
                {
                  color: startColor,
                  fontWeight: isCenter ? 700 : 400,
                  display: "inline-block",
                  transformOrigin: "center center",
                  animation: animationValue,
                  "--pulse-color": pulseColor,
                  "--start-color": startColor,
                  "--end-color": endColor,
                  "--flicker-color": flickerBright,
                  visibility: outsideCircle ? "hidden" : "visible",
                  lineHeight: 1,
                } as any
              }
            >
              {displayedChar}
            </span>
          </div>
        );
      })}
    </div>
  );
}
