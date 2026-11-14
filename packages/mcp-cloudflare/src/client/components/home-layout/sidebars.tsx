interface SidebarProps {
  toggleChat: (open: boolean) => void;
  isChatOpen: boolean;
}

export function Sidebars({ isChatOpen, toggleChat }: SidebarProps) {
  return (
    <>
      {/* left sidebar */}
      <aside className="group hidden sm:block fixed left-0 inset-y-0 h-full w-(--sidebar-width) bg-fixed bg-[repeating-linear-gradient(-45deg,#fff2,#fff2_1px,#fff0_1.5px,#fff0_12px)] z-10 border-r opacity-50 bg-clip-padding border-white/20" />
      {/* right sidebar */}
      <button
        className={`group hidden sm:grid fixed right-0 inset-y-0 h-full w-1/2 duration-300 cursor-pointer place-items-center z-40 border-l transition-colors ${
          isChatOpen
            ? "bg-background-2 -translate-x-[1px] opacity-100 border-white/10 motion-safe:transition-all"
            : "translate-x-[calc(var(--x)/2)] opacity-50 hover:bg-background-2 bg-clip-padding border-white/20 bg-[repeating-linear-gradient(-45deg,#fff2,#fff2_1px,#fff0_1.5px,#fff0_12px)]"
        }`}
        onClick={() => toggleChat(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            toggleChat(true);
          }
        }}
        // the header button to open chat will remain tabbable
        tabIndex={-1}
        type="button"
      >
        <span className="sr-only">Open chat panel</span>
        {!isChatOpen && (
          <div className="font-mono absolute w-8 xl:w-12 min-[1800px]:w-fit min-[1800px]:flex-nowrap text-center flex flex-wrap justify-center md:left-[calc((100vw-var(--x))/4)] top-1/2 -translate-1/2 opacity-0 group-hover:opacity-100 px-1 gap-0.25 gap-x-2">
            <div className="flex flex-nowrap">
              {"open".split("").map((char, i) => (
                <span
                  key={`open-${i}`}
                  className="animate-openchat"
                  // per-index delay so animation cascades
                  style={{ "--delay": `${i * 80}ms` }}
                >
                  <span className="relative" aria-hidden>
                    <span className="original inline-block leading-[1]">
                      {char === " " ? "\u00A0" : char}
                    </span>
                    <span
                      className="underscore absolute inset-0 leading-[1]"
                      aria-hidden="true"
                      role="presentation"
                    >
                      _
                    </span>
                  </span>
                </span>
              ))}
            </div>
            <div className="flex flex-nowrap">
              {"chat".split("").map((char, i) => {
                // offset so "chat" follows "open" + 1ch space
                const offsetChars = "open".length + 1;
                return (
                  <span
                    key={`chat-${i}`}
                    className="animate-openchat"
                    style={{
                      "--delay": `${(offsetChars + i) * 80}ms`,
                    }}
                  >
                    <span className="relative" aria-hidden>
                      <span className="original inline-block leading-[1]">
                        {char === " " ? "\u00A0" : char}
                      </span>
                      <span
                        className="underscore absolute inset-0 leading-[1]"
                        aria-hidden="true"
                        role="presentation"
                      >
                        _
                      </span>
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </button>
    </>
  );
}
