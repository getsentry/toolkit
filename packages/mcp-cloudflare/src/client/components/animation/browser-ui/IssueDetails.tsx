import { ChevronDown } from "lucide-react";

export default function IssueDetails({ step }: { step: number }) {
  return (
    <>
      <div
        className={`${
          step === 1 ? "opacity-100" : step > 1 ? "opacity-0" : "opacity-40"
        } rounded-xl border border-white/0 bg-white/0 duration-300`}
        id="stack-trace-container"
      >
        <div className="w-full border-white/5 flex justify-between items-center border-b bg-white/0 p-3">
          Highlights
          <ChevronDown className="h-5 w-5 text-white/50" />
        </div>
        <div className="w-full p-3 flex items-center justify-between">
          Stack Trace
          <ChevronDown className="h-5 w-5 text-white/50 -scale-y-100" />
        </div>
        <div className="relative w-[calc(100%-1rem)] m-2 border border-white/10 bg-white/5 rounded-xl">
          <div
            className={`${
              step === 1
                ? "motion-reduce:opacity-0 motion-reduce:duration-1000 motion-reduce:delay-800 motion-reduce:!animate-none animate-issue-context opacity-30"
                : "opacity-0"
            } pb-4 rounded-xl absolute inset-0 border border-white/20 bg-pink-900 text-pink100`}
            style={{ "--delay": "0.8s" }}
          >
            <div className="h-full w-full rounded-xl border border-white/20 bg-white/10 pb-4" />
          </div>
          <div
            className={`${
              step === 1
                ? "motion-reduce:opacity-0 motion-reduce:duration-1000 motion-reduce:delay-1000 motion-reduce:!animate-none animate-issue-context opacity-30"
                : "opacity-0"
            } pb-4 rounded-xl absolute inset-0 border border-white/20 bg-pink-900 text-pink100`}
            style={{ "--delay": "1s" }}
          >
            <div className="h-full w-full rounded-xl border border-white/20 bg-white/10 pb-4" />
          </div>
          <div
            className={`${
              step === 1
                ? "motion-reduce:opacity-0 motion-reduce:duration-1000 motion-reduce:delay-1200 motion-reduce:!animate-none animate-issue-context opacity-30"
                : "opacity-0"
            } pb-4 rounded-xl absolute inset-0 border border-white/20 bg-pink-900 text-pink100`}
            style={{ "--delay": "1.2s" }}
          >
            <div className="h-full w-full rounded-xl border border-white/20 bg-white/10 pb-4" />
          </div>
          <div
            className={`${
              step === 1
                ? "motion-reduce:opacity-0 motion-reduce:duration-1000 motion-reduce:delay-675 motion-reduce:!animate-none animate-issue-context"
                : step > 1
                  ? "opacity-0"
                  : "opacity-100"
            } pb-4 rounded-xl border border-white/20 bg-pink-900 text-pink100`}
            style={{ "--delay": "0.675s" }}
          >
            <div className="h-full w-full rounded-xl border border-white/20 bg-white/10 pb-4">
              <pre>
                {`
  Error: Something went wrong
    at main.js:123
    at index.js:456`}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
