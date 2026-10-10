"use client";

import "asciinema-player/dist/bundle/asciinema-player.css";
import "./dracula.css";
import { useCallback, useEffect, useRef, useState } from "react";
import BrowserAnimation from "./BrowserAnimation";
import KeysPaste from "./terminal-ui/keys-paste";
import SpeedDisplay from "./terminal-ui/SpeedDisplay";
import StepsList from "./terminal-ui/StepsList";
import DataWire from "./DataWire";

export type Step = {
  type?: string;
  label: string;
  description: string;
  startTime: number;
  // NOTE: hardcoded to 1000ms on mobile
  pauseMs: number | null;
};

// Helper functions extracted to avoid nested ternaries (per project guidelines)
function getBorderColorClass(index: number): string {
  switch (index) {
    case 1:
      return "xl:border-orange-400/50";
    case 2:
      return "xl:border-pink-400/50";
    case 4:
      return "xl:border-lime-200/50";
    default:
      return "border-white/10";
  }
}

function getPulseColorClass(index: number): string {
  switch (index) {
    case 4:
      return "text-lime-200/50";
    case 2:
      return "text-pink-400/50";
    default:
      return "text-orange-400/50";
  }
}

const steps: Step[] = [
  {
    label: "Copypaste Sentry Issue URL",
    description: "Copy the Sentry issue url directly from your browser",
    startTime: 31.6,
    pauseMs: 2500,
  },
  {
    type: "[toolcall]",
    label: "get_sentry_resource()",
    description: "MCP performs a toolcall to fetch issue details",
    startTime: 40,
    pauseMs: 1750,
  },
  {
    type: "[toolcall]",
    label: "analyze_issue_with_seer()",
    description:
      "A toolcall to Seer to analyze the stack trace and pinpoint the root cause",
    startTime: 46,
    pauseMs: 2000,
  },
  {
    type: "[LLM]",
    label: "Finding solution",
    description: "LLM analyzes the context and comes up with a solution",
    startTime: 48.5,
    pauseMs: 50,
  },
  {
    type: "[LLM]",
    label: "Applying Edits",
    description: "LLM adds the suggested solution to the codebase",
    startTime: 146,
    pauseMs: 50,
  },
  {
    label: "Validation",
    description: "Automatically running tests to verify the solution works",
    startTime: 242,
    pauseMs: 50,
  },
];

export default function TerminalAnimation() {
  const playerRef = useRef<any>(null);
  const cliDemoRef = useRef<HTMLDivElement | null>(null);

  const autoContinueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const currentStepRef = useRef<number>(-1);

  const [speed, setSpeed] = useState<number>(3.0);
  const OFFSET = 0.01;

  const didInitRef = useRef(false);
  const isMobileRef = useRef(false);

  const isManualSeekRef = useRef(false);

  const clearAllTimers = useCallback(() => {
    if (autoContinueTimerRef.current) {
      clearTimeout(autoContinueTimerRef.current);
      autoContinueTimerRef.current = null;
    }
  }, []);

  const hardDispose = useCallback(() => {
    clearAllTimers();
    try {
      const p = playerRef.current;
      p?.pause?.();
      p?.dispose?.();
    } catch {}
    playerRef.current = null;
    try {
      cliDemoRef.current?.replaceChildren();
    } catch {}
  }, [clearAllTimers]);

  const gotoStep = useCallback(
    (idx: number) => {
      const p = playerRef.current;
      if (!p) return;

      const step = steps[idx];
      if (!step) return;

      clearAllTimers();
      isManualSeekRef.current = true;

      const isFastStep = idx === 3 || idx === 4;
      const newSpeed = isFastStep ? 30 : 3;
      setSpeed(newSpeed);

      try {
        p.pause?.();
        p.seek?.(step.startTime + (isFastStep ? 87 : OFFSET)); // skip 87 seconds fakes a 30x speedup
      } catch (err) {
        console.error("[TerminalAnimation] gotoStep seek failed", {
          stepIndex: idx,
          label: step.label,
          err,
        });
      }

      currentStepRef.current = idx;
      setCurrentIndex(idx);

      setTimeout(() => {
        isManualSeekRef.current = false;
      }, 100);
      // NOTE (for self): 1s delay on mobile got left out during handleMarkerReached consolidantion into gotoStep, bring back gotoStep(markerIndex, source: "marker" | "manual") if needed to add back
      const mobile = isMobileRef.current;

      if (mobile) {
        try {
          p.play?.();
        } catch {}
      } else if (step.pauseMs) {
        autoContinueTimerRef.current = setTimeout(() => {
          try {
            p.play?.();
          } catch {}
        }, step.pauseMs);
      }
    },
    [clearAllTimers],
  );

  const handleMarkerReached = useCallback(
    (markerIndex: number) => {
      gotoStep(markerIndex);
    },
    [gotoStep],
  );

  const mountOnce = useCallback(async () => {
    if (playerRef.current) return;

    try {
      isMobileRef.current =
        (typeof window !== "undefined" &&
          window.matchMedia?.("(hover: none)")?.matches) ||
        (typeof window !== "undefined" && window.innerWidth < 768);
    } catch {
      isMobileRef.current = false;
    }

    if (typeof WebAssembly === "undefined") return;
    const AsciinemaPlayerLibrary = await import("asciinema-player" as any);
    if (!cliDemoRef.current) return;

    // Convert steps to markers format: [time, label]
    const markers = steps.map((step) => [step.startTime, step.label]);

    const player = AsciinemaPlayerLibrary.create(
      "demo.cast",
      cliDemoRef.current,
      {
        // NOTE: defaults to 80cols x 24rows until .cast loads, pulls size of terminal recondinf from .cast on load, unless below specified
        rows: Math.max(
          1,
          Math.floor(
            ((cliDemoRef.current?.getBoundingClientRect().height ?? 0) - 18) /
              16.82, // line-height
          ),
        ), // -18 for 9px border on <pre> for terminal output
        // NOTE: fits cols to container width (which is extended to 200% on mobile for optimal font-size result), or rows (specified above) to container height by decreasing the font size (note below)
        fit: "width",
        // NOTE: only works when fit: false
        // terimnalFontSize: 14,
        // NOTE: customized above in dracula.css
        theme: "dracula",
        controls: false,
        autoPlay: false,
        loop: false,
        idleTimeLimit: 0.1,
        speed: 3.0,
        startAt: steps[0].startTime,
        preload: true,
        pauseOnMarkers: false,
        markers: markers,
      },
    );

    playerRef.current = player;

    // Listen to marker events from the player
    player.addEventListener("marker", (event: any) => {
      const { index } = event;
      if (!isManualSeekRef.current) {
        handleMarkerReached(index);
      }
    });
  }, [handleMarkerReached]);

  const restart = useCallback(() => {
    clearAllTimers();
    const p = playerRef.current;
    if (!p) return;

    currentStepRef.current = -1;
    setCurrentIndex(-1);

    try {
      p.pause?.();
      p.seek?.(steps[0].startTime - OFFSET);
      setSpeed(3);
    } catch {}

    // Start from the first marker
    setTimeout(() => {
      try {
        p.play?.();
      } catch {}
    }, 100);
  }, [clearAllTimers]);

  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    (async () => {
      await mountOnce();
      // Start playing from the first marker
      setTimeout(() => {
        const p = playerRef.current;
        try {
          p?.play?.();
        } catch {}
      }, 100);
    })();

    return () => {
      clearAllTimers();
      hardDispose();
    };
  }, [mountOnce, clearAllTimers, hardDispose]);

  return (
    <>
      <div
        className={`${getBorderColorClass(currentIndex)} relative w-full flex flex-col justify-between col-span-2 gap-8 max-xl:row-span-6 border bg-background/50 rounded-xl sm:rounded-3xl overflow-hidden`}
      >
        <div className="w-full relative overflow-hidden min-h-56 h-full sm:[mask-image:radial-gradient(circle_at_top_right,transparent_10%,red_20%)] [mask-image:radial-gradient(circle_at_top_right,transparent_20%,red_30%)]">
          <div
            className="absolute bottom-0 right-0 left-1 flex justify-start h-full w-[60rem] overflow-hidden rounded-xl sm:rounded-3xl [mask-image:linear-gradient(to_bottom,transparent,red_0.5rem,red_calc(100%-0.5rem),transparent)] [&>.ap-wrapper>.ap-player]:w-full [&>.ap-wrapper]:w-full [&>.ap-wrapper]:flex [&>.ap-wrapper]:!justify-start [&>.ap-wrapper>.ap-player>.ap-terminal]:absolute [&>.ap-wrapper>.ap-player>.ap-terminal]:bottom-0"
            ref={cliDemoRef}
          />
        </div>

        <SpeedDisplay speed={speed} />
        <KeysPaste step={currentIndex} />

        <div className="relative bottom-0 inset-x-0">
          <StepsList
            onSelectAction={(i) => (i === 0 ? restart() : gotoStep(i))}
            globalIndex={Math.max(currentIndex, 0)}
            className=""
            restart={restart}
            steps={steps}
          />
        </div>
      </div>

      <div
        className={`${
          currentIndex > 4 ? "opacity-0 scale-y-50" : "opacity-100 scale-y-100"
        } duration-300 max-xl:hidden absolute h-full inset-y-0 left-1/2 -translate-x-1/2 w-8 py-12 flex justify-around flex-col`}
      >
        {Array.from({ length: 24 }).map((_, i) => (
          <DataWire
            key={i}
            active={
              currentIndex === 1 || currentIndex === 2 || currentIndex === 4
            }
            direction={currentIndex === 4 ? "ltr" : "rtl"}
            pulseColorClass={getPulseColorClass(currentIndex)}
            heightClass="h-0.5"
            periodSec={0.3}
            pulseWidthPct={200}
            delaySec={Math.random() * 0.3}
          />
        ))}
      </div>

      <div className="relative max-xl:row-span-0 hidden col-span-2 xl:flex flex-col w-full">
        <BrowserAnimation globalIndex={currentIndex} />
      </div>
    </>
  );
}
