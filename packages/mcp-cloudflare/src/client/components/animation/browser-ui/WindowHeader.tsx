import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Copy,
  Lock,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Share,
} from "lucide-react";

export default function WindowHeader({
  step,
  ide = false,
}: {
  step?: number;
  ide?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 max-w-full p-2 pr-2 pl-4 ${
        ide && "pr-1"
      }`}
    >
      <div className="size-3 flex-shrink-0 rounded-full border border-white/20 bg-pink-300/50" />
      <div className="size-3 flex-shrink-0 rounded-full border border-white/20 bg-amber-300/50" />
      <div className="mr-4 size-3 flex-shrink-0 rounded-full border border-white/20 bg-emerald-300/50" />
      {/*<PanelLeft />*/}
      {ide ? (
        <>
          <ArrowLeft className="size-5" />
          <ArrowRight className="size-5" />
        </>
      ) : (
        <>
          <ChevronLeft className="size-5" />
          <ChevronRight className="size-5" />
        </>
      )}
      {/*<ShieldCheck className="ml-auto"/>*/}
      <div
        className={`mx-auto flex items-center ${
          ide && "justify-center"
        } h-8 w-full max-w-1/2 cursor-pointer gap-2 rounded-xl border border-white/20 bg-white/5 p-3 duration-200 hover:bg-white/10 active:bg-white/50 active:duration-75`}
        style={{ "--delay": "0.45s" }}
      >
        {!ide && <Lock className="size-4 flex-shrink-0" />}
        {ide && <Search className="size-4 flex-shrink-0" />}
        <div className="truncate relative">
          <div
            className={`absolute w-full h-[1lh] bg-pink-500 -z-10 ${
              step === 0
                ? "animate-select opacity-100"
                : "opacity-0 duration-300"
            }`}
          />
          {ide
            ? "Search"
            : "https://sentry.sentry.io/issues/6811213890/?environment=cloudflare&project=4509062593708032&query=is%3Aunresolved&referrer=issue-stream&seerDrawer=true"}
        </div>
        {!ide && <RotateCcw className="size-4 flex-shrink-0" />}
      </div>
      {ide ? (
        <>
          <PanelLeft className="ml-1 size-4" />
          <PanelBottom className="ml-1 hidden size-4 2xl:block" />
          <PanelRight className="ml-1 hidden size-4 2xl:block" />
          <Settings className="mr-2 ml-1 size-4" />
        </>
      ) : (
        <>
          <Share className="ml-2 size-4" />
          <Plus className="ml-2 hidden size-4 2xl:block" />
          <Copy className="mr-3 ml-2 size-4" />
        </>
      )}
    </div>
  );
}
