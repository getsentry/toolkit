import { useSearchParams } from "react-router-dom";
import { Button } from "./ui/button";
import CliSetup, { CliInstallSteps, CliSetupTabs } from "./fragments/cli-setup";
import RemoteSetup, { RemoteSetupTabs } from "./fragments/remote-setup";
import { Cloud, Terminal } from "lucide-react";

type Transport = "cloud" | "cli";

const TRANSPORTS: ReadonlyArray<{
  id: Transport;
  label: string;
  icon: React.ReactNode;
}> = [
  {
    id: "cloud",
    label: "Cloud",
    icon: <Cloud className="size-4 fill-current" />,
  },
  { id: "cli", label: "CLI", icon: <Terminal className="size-4" /> },
];

function parseTransport(value: string | null): Transport {
  // The CLI flow replaced the npx stdio flow; keep old ?transport=stdio links working.
  return value === "cli" || value === "stdio" ? "cli" : "cloud";
}

export default function Integration() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive state from query params with defaults
  const transport = parseTransport(searchParams.get("transport"));
  const selectedIde = searchParams.get("ide") || "claude-code";

  const updateParams = (updates: { transport?: Transport; ide?: string }) => {
    const newParams = new URLSearchParams(searchParams);
    if (updates.transport !== undefined) {
      newParams.set("transport", updates.transport);
    }
    if (updates.ide !== undefined) {
      newParams.set("ide", updates.ide);
    }
    setSearchParams(newParams, { replace: true });
  };

  const setSelectedIde = (ide: string) => updateParams({ ide });
  return (
    <section
      id="getting-started"
      className="flex flex-col md:max-w-3xl mx-auto relative mb-12 -scroll-mt-8 max-w-full"
    >
      <div className="flex flex-wrap justify-between items-center gap-3 px-4 sm:px-8 pt-4 sm:pt-8 pb-4">
        <h1 className="text-2xl md:text-2xl font-semibold">Installation</h1>
        <div className="flex items-center text-xs bg-background-3 rounded-xl p-1 size-fit -translate-x-[1.5px] z-20 border-[0.5px] border-violet-300/50 gap-0.5">
          {TRANSPORTS.map(({ id, label, icon }) => (
            <Button
              key={id}
              variant={transport === id ? "default" : "secondary"}
              size="xs"
              onClick={() => {
                updateParams({ transport: id });
                document
                  .getElementById("getting-started")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={`${
                transport === id && "shadow-sm"
              } rounded-lg !pr-3 !pl-2 focus:!ring-violet-300 focus-visible:z-30 focus:ring-offset-1 focus:ring-offset-background-3`}
            >
              {icon}
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* Client installation tabs first */}
      <div className="p-4 sm:p-8 pt-0 sm:pt-0 border-b border-dashed border-white/10">
        {transport === "cloud" && (
          <RemoteSetupTabs
            selectedIde={selectedIde}
            onIdeChange={setSelectedIde}
          />
        )}
        {transport === "cli" && (
          <>
            <CliInstallSteps />
            <CliSetupTabs
              selectedIde={selectedIde}
              onIdeChange={setSelectedIde}
            />
          </>
        )}
      </div>

      <div className="px-4 sm:px-8 pt-4 sm:pt-8 pb-4">
        {/* Advanced options after */}
        <div className="relative min-h-0">
          {transport === "cloud" && (
            <div
              key="cloud"
              className="animate-in fade-in motion-safe:slide-in-from-left-4 duration-300"
            >
              <RemoteSetup />
            </div>
          )}
          {transport === "cli" && (
            <div
              key="cli"
              className="animate-in fade-in motion-safe:slide-in-from-right-4 duration-300"
            >
              <CliSetup />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
