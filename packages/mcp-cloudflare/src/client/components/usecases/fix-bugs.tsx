import { BugOff } from "lucide-react";

export default function FixBugs() {
  return (
    <div className="p-4 sm:p-8 lg:max-xl:border-r border-b border-dashed border-white/10 overflow-hidden justify-end flex flex-col group relative">
      <div className="absolute inset-0 pointer-events-none bg-grid [--size:1rem] [mask-image:linear-gradient(to_bottom,red,transparent,red)] group-hover:opacity-50 opacity-30 duration-300 -z-20" />
      <div className="relative min-h-64 [mask-image:linear-gradient(to_bottom,rgba(0,0,0,1)_60%,rgba(0,0,0,0)_100%)] mb-auto">
        {/* window 1 (browser) */}
        <div className="border rounded-2xl border-white/10 overflow-hidden bg-background-2 absolute top-0 left-0 bottom-0 right-8 translate-y-8 group-hover:translate-y-0 duration-200 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]">
          <div className="flex items-center pl-3.5 py-0.5 gap-1.5">
            <div className="size-2 flex-shrink-0 rounded-full border border-white/20 bg-pink-300/50" />
            <div className="size-2 flex-shrink-0 rounded-full border border-white/20 bg-amber-300/50" />
            <div className="mr-2 size-2 flex-shrink-0 rounded-full border border-white/20 bg-emerald-300/50" />
            <div className="rounded-l-lg -mr-1.5 border border-white/10 bg-white/5 pl-2 py-1 text-xs truncate">
              <span className="relative block overflow-hidden truncate">
                <div className="absolute inset-0 size-full bg-select -translate-x-full group-hover:translate-x-0 group-hover:duration-500 ease-[steps(20)]" />
                <span className="z-10 relative">
                  https://sentry.sentry.io/issues/6811213890/?environment=cloudflare&project=4509062593708032&query=is%3Aunresolved&referrer=issue-stream&seerDrawer=true
                </span>
              </span>
            </div>
          </div>
        </div>
        {/* window 2 (terminal) */}
        <div className="border rounded-2xl border-white/10 bg-background absolute top-8 left-8 bottom-0 right-0 p-4 text-xs font-mono translate-y-8 group-hover:translate-y-0 duration-200 group-hover:delay-1000 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]">
          &gt;&nbsp;fix&nbsp;
          <span className="group-hover:text-white inline text-transparent group-hover:delay-1000">
            https://sentry.sentry.io/issues/6811213890/?environment=cloudflare&project=4509062593708032&query=is%3Aunresolved&referrer=issue-stream&seerDrawer=true
          </span>
          <br />
          <span className="group-hover:delay-1200 duration-300 translate-y-8 group-hover:translate-y-0 opacity-0 group-hover:opacity-100 ease-[cubic-bezier(0.175,0.885,0.32,1.275)]">
            <span className="[animation:spinStar_2s_steps(12)_infinite] group-hover:[animation-play-state:running] [animation-play-state:paused] inline-block origin-center text-orange-400">
              *
            </span>
            &nbsp;
            {"fixing...".split("").map((char, i) => (
              <span
                key={i}
                style={{ "--delay": `${i * 0.1}s` }}
                className="text-orange-500 [animation:wave_1s_steps(2)_infinite] [animation-delay:var(--delay)] group-hover:[animation-play-state:running] [animation-play-state:paused]"
              >
                {char}
              </span>
            ))}
          </span>
        </div>
      </div>
      <div className="flex">
        <div className="flex flex-col">
          <h3 className="md:text-xl font-bold">Fix Bugs</h3>
          <p className="text-balance text-white/70">
            Ship fast, break things—then unbreak them. Sentry MCP makes
            debugging less <span className="text-[#fd918f]">“wtf”</span> and
            more <span className="text-lime-300">“ah, got it.”</span>
          </p>
        </div>
        <BugOff className="size-16 ml-auto text-white/20 group-hover:text-white/40 stroke-[0.5px] duration-300 mt-auto" />
      </div>
    </div>
  );
}
