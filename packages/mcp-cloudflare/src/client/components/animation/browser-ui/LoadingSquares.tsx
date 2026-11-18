"use client";
import { useEffect, useRef, useState } from "react";

type Props = {
  step: number; // run when step === 3
  cellSize?: number;
  baseAlpha?: number;
  peakAlpha?: number;
  sweepMs?: number;
  decayMs?: number;
  fadeInMs?: number;
  transparentRatio?: number;
};

export default function LoadingSquares({
  step,
  cellSize = 12,
  baseAlpha = 0.04,
  peakAlpha = 0.25,
  sweepMs = 3000,
  decayMs = 300,
  fadeInMs = 300,
  transparentRatio = 0.5,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const gridRef = useRef<{
    cols: number;
    rows: number;
    dpr: number;
    w: number;
    h: number;
  } | null>(null);
  const tStartRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const resizeObsRef = useRef<ResizeObserver | null>(null);

  const clamp = (v: number, a: number, b: number) =>
    Math.max(a, Math.min(b, v));

  // Deterministic per-cell noise in [0,1)
  function rnd2(i: number, j: number) {
    let h =
      (Math.imul(i + 374761393, 668265263) ^
        Math.imul(j + 1442695041, 340573321)) >>>
      0;
    h ^= h >>> 13;
    h = Math.imul(h, 1274126177) >>> 0;
    return (h & 0x7fffffff) / 0x80000000;
  }

  function setupGrid(canvas: HTMLCanvasElement) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const cols = Math.max(1, Math.floor(cssW / cellSize));
    const rows = Math.max(1, Math.floor(cssH / cellSize));
    gridRef.current = { cols, rows, dpr, w: canvas.width, h: canvas.height };
  }

  function drawFrame(ts: number) {
    const canvas = canvasRef.current;
    const grid = gridRef.current;
    if (!canvas || !grid) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { cols, rows, dpr, w, h } = grid;
    const px = cellSize * dpr;

    ctx.clearRect(0, 0, w, h);

    const t0 = tStartRef.current ?? ts;
    const tElapsed = ts - t0;

    const prog = tElapsed / sweepMs; // unbounded (keeps moving after reaching the top)
    const frontRow = rows * (1 - prog); // rows..0..(-∞)

    // Beam shape
    const beamHalf = 0.35; // rows
    const feather = 0.9; // rows
    const maxShadow = 8 * dpr;

    // Stop when bottom tail has decayed below epsilon
    const EPS = 0.01;
    const tailMsNeeded = -decayMs * Math.log(EPS);
    const finished = prog >= 1 && tElapsed >= sweepMs + tailMsNeeded;

    const shimmerT = ts;

    for (let r = 0; r < rows; r++) {
      const dRows = frontRow - (r + 0.5);

      // Row-level beam profile (works even when frontRow < 0; then beam ≈ 0)
      let beam = 0;
      if (Math.abs(dRows) <= beamHalf + feather) {
        const x = clamp((Math.abs(dRows) - beamHalf) / feather, 0, 1);
        const soft = 1 - x * x * (3 - 2 * x); // smoothstep
        beam = soft;
      }

      // Afterglow for rows already passed (dRows < 0)
      let glow = 0;
      if (dRows < 0) {
        const rowsPerMs = rows / sweepMs;
        const msSince = Math.abs(dRows) / rowsPerMs; // increases even past top
        glow = Math.exp(-msSince / decayMs);
      }

      const baseHue = 275 + Math.sin(r + shimmerT * 0.0004) * 8;
      const pxInset = 0.8 * dpr;
      const shimmerY =
        (Math.sin(shimmerT * 0.008 + r * 7.13) * 0.02 +
          Math.cos(shimmerT * 0.006 + r * 3.7) * 0.015) *
        dpr;

      for (let c = 0; c < cols; c++) {
        // Permanent transparency mask (~50%)
        const mask = rnd2(c * 17 + 5, r * 23 + 11) < transparentRatio;
        if (mask) continue;

        // Per-cell dithering (stable)
        const nGlow = 0.75 + rnd2(c, r) * 0.6; // 0.75..1.35
        const nBeam = 0.9 + rnd2(c * 3 + 7, r * 5 + 11) * 0.2; // 0.90..1.10
        const beamCell = clamp(beam * nBeam, 0, 1);
        const glowCell = clamp(glow * nGlow, 0, 1);

        const aCell = Math.min(
          peakAlpha,
          Math.max(
            baseAlpha,
            baseAlpha + (peakAlpha - baseAlpha) * Math.max(beamCell, glowCell),
          ),
        );

        const hot = aCell > baseAlpha + 0.1;
        ctx.shadowBlur = hot ? maxShadow * (aCell / peakAlpha) : 0;
        ctx.shadowColor = `hsla(${baseHue}, 90%, 65%, ${aCell * 0.7})`;

        const sx = Math.floor(c * px);
        const sy = Math.floor(r * px + shimmerY);
        const hueJitter = (rnd2(c * 13 + 3, r * 19 + 5) - 0.5) * 6; // ±3°
        ctx.fillStyle = `hsla(${baseHue + hueJitter}, 85%, 65%, ${aCell})`;
        ctx.fillRect(
          sx + pxInset,
          sy + pxInset,
          px - 2 * pxInset,
          px - 2 * pxInset,
        );
      }
    }

    if (finished) {
      runningRef.current = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
  }

  function loop(ts: number) {
    if (!runningRef.current) return;
    drawFrame(ts);
    rafRef.current = requestAnimationFrame(loop);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const start = () => {
      if (runningRef.current) return;
      setupGrid(canvas);
      tStartRef.current = performance.now(); // start immediately
      runningRef.current = true;
      // CSS fade-in while sweep already runs
      setVisible(false);
      requestAnimationFrame(() => setVisible(true));
      rafRef.current = requestAnimationFrame(loop);
    };
    const stop = () => {
      runningRef.current = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      tStartRef.current = null;
      setVisible(false);
    };

    const ro = new ResizeObserver(() => {
      if (!runningRef.current) return;
      setupGrid(canvas);
    });
    resizeObsRef.current = ro;

    if (step === 3) {
      setupGrid(canvas);
      ro.observe(canvas);
      start();
    } else {
      ro.disconnect();
      stop();
    }

    return () => {
      ro.disconnect();
      stop();
    };
  }, [
    step,
    cellSize,
    baseAlpha,
    peakAlpha,
    sweepMs,
    decayMs,
    fadeInMs,
    transparentRatio,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 size-full"
      style={{
        background: "transparent",
        opacity: visible ? 1 : 0,
        transition: `opacity ${fadeInMs}ms ease-out`,
      }}
      aria-hidden
    />
  );
}
