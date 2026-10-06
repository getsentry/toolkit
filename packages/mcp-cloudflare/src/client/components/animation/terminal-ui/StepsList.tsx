"use client";
import { BookCheck, ChevronRight, RotateCcw, User } from "lucide-react";
import type { Step } from "../TerminalAnimation";

export default function StepsList({
  steps,
  globalIndex,
  onSelectAction,
  className = "",
  restart,
}: {
  steps: Step[];
  globalIndex: number;
  onSelectAction: (index: number) => void;
  className?: string;
  restart: () => void;
}) {
  return (
    <div
      className={`flex flex-row-reverse h-full w-full relative ${className}`}
    >
      <div className="absolute -translate-y-5 inset-x-5 w-full top-0 flex">
        {steps.map((step, idx) => {
          return (
            <div
              key={step.label}
              className={`h-1.5 rounded-full mx-1 my-2.5 duration-300 ease-out-cubic
              ${
                idx < globalIndex
                  ? "bg-lime-300 w-10 sm:w-12"
                  : idx === globalIndex
                    ? "bg-violet-300 w-10 sm:w-12"
                    : "bg-background-3 w-10 sm:w-12"
              }
              `}
            />
          );
        })}
      </div>
      {/* 3.5 = 7/2 (center of 7 steps) */}
      {/* 17.5 is what each step is transitioned by below for stacking */}
      {steps.map((step, idx) => {
        const isActive = idx === globalIndex;
        return (
          <div
            aria-current={isActive ? "step" : undefined}
            className={`group flex flex-col overflow-hidden rounded-xl p-2 text-left duration-300 w-full bg-background-1 h-[6.525rem] sm:h-[5.125rem]
            ${
              !isActive &&
              "absolute !opacity-0 !pointer-events-none translate-y-full !bg-transparent"
            }`}
            key={step.label}
          >
            <div className="flex items-center gap-3 pb-2 max-sm:text-sm">
              <span className="font-mono flex items-center h-8 text-sm opacity-50 ml-3.5">
                {idx === 0 ? (
                  <User className="size-4" />
                ) : idx > 4 ? (
                  <BookCheck className="size-4" />
                ) : (
                  step.type
                )}
              </span>
              <span
                className={`inline-block duration-200 ease-[cubic-bezier(0.64,0.57,0.67,1.53)] ${
                  !isActive &&
                  "group-hover:translate-x-4 group-hover:duration-75"
                } max-sm:contents`}
              >
                {step.label}
              </span>
            </div>
            <div
              className={`grid ${
                isActive
                  ? "-mt-1 grid-rows-[1fr] opacity-100"
                  : "mt-0 grid-rows-[0fr] opacity-0"
              } transition-all duration-500 ease-out-expo`}
            >
              <div className="overflow-hidden">
                <p
                  className={`${
                    isActive
                      ? "translate-y-0 scale-100 opacity-100"
                      : "translate-y-10 scale-96 opacity-0"
                  } px-4 max-sm:pr-16 pb-3 text-copy-lg max-sm:text-sm text-white/50 transition-all duration-500 ease-out-cubic`}
                >
                  {step.description}
                </p>
              </div>
            </div>
          </div>
        );
      })}
      <button
        className={`absolute right-4 bottom-4 border ${
          globalIndex === 5 ? "group/replay" : "group/next"
        } my-auto bg-background-2 border-white/10 size-12 z-20 rounded-full grid place-items-center text-left text-white/50 active:duration-75 cursor-pointer active:bg-white/40 hover:bg-background-3 active:scale-90 duration-300`}
        tabIndex={0}
        type="button"
        onClick={() => {
          if (globalIndex === 5) {
            restart();
          } else {
            onSelectAction(Math.min(globalIndex + 1, steps.length - 1));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (globalIndex === 5) {
              if (typeof restart === "function") restart();
            } else {
              onSelectAction(Math.min(globalIndex + 1, steps.length - 1));
            }
          }
        }}
      >
        {globalIndex === 5 ? (
          <RotateCcw className="inline-block size-4 group-hover/replay:-rotate-360 group-hover/replay:ease-out group-hover/replay:duration-1000 group-active/replay:duration-75 group-active/replay:-rotate-360 group-active/replay:scale-150" />
        ) : (
          <ChevronRight className="size-6 group-active/next:scale-y-75 group-active/next:translate-x-2 group-active/next:duration-75 duration-300" />
        )}
      </button>
    </div>
  );
}
