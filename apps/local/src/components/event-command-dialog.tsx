import type { LucideIcon } from "lucide-react";
import { Search } from "lucide-react";
import { type RefObject, useEffect } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.tsx";
import type { LocalFeedItem } from "@/lib/spotlight.ts";
import { eventSearchValue, type WorkspaceView } from "@/lib/workspace.ts";

export type CommandNavigationItem = {
  icon: LucideIcon;
  id: WorkspaceView;
  label: string;
};

type EventCommandDialogProps = {
  enabled: boolean;
  items: LocalFeedItem[];
  navigation: CommandNavigationItem[];
  open: boolean;
  query: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  onNavigate: (view: WorkspaceView) => void;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onSelectItem: (item: LocalFeedItem) => void;
  onFilterView?: (query: string) => void;
  currentViewLabel?: string;
};

export function EventCommandDialog({
  enabled,
  items,
  navigation,
  open,
  query,
  triggerRef,
  onNavigate,
  onOpenChange,
  onQueryChange,
  onSelectItem,
  onFilterView,
  currentViewLabel = "current view",
}: EventCommandDialogProps) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const openWithShortcut = (event: KeyboardEvent) => {
      if (
        (!event.metaKey && !event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      onOpenChange(true);
    };

    window.addEventListener("keydown", openWithShortcut);
    return () => window.removeEventListener("keydown", openWithShortcut);
  }, [enabled, onOpenChange]);

  const close = () => {
    onOpenChange(false);
    queueMicrotask(() => triggerRef?.current?.focus());
  };

  return (
    <CommandDialog
      open={open}
      title="Search this session"
      description="Find events across this capture or jump to another view. Your view filter changes only when you choose Filter."
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          onOpenChange(true);
          return;
        }
        close();
      }}
    >
      <CommandInput
        autoFocus
        aria-label="Search this session"
        placeholder="Search events and views"
        value={query}
        onValueChange={onQueryChange}
      />
      <CommandList>
        <CommandEmpty>No matching events or views.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {navigation.map((entry) => {
            const Icon = entry.icon;
            return (
              <CommandItem
                key={entry.id}
                value={entry.label}
                onSelect={() => {
                  onNavigate(entry.id);
                  close();
                }}
              >
                <Icon aria-hidden="true" />
                {entry.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandGroup heading="Events">
          {items.map((item) => (
            <CommandItem
              key={item.id}
              value={eventSearchValue(item)}
              onSelect={() => {
                onSelectItem(item);
                close();
              }}
            >
              <Search aria-hidden="true" />
              <span className="min-w-0 truncate">
                {item.metadata?.title ?? item.type}
              </span>
              <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                {item.type}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
        {query.trim() && onFilterView ? (
          <CommandGroup heading={`Filter ${currentViewLabel}`}>
            <CommandItem
              value={`filter current view ${query}`}
              onSelect={() => {
                onFilterView(query.trim());
                close();
              }}
            >
              <Search aria-hidden="true" />
              <span className="min-w-0 truncate">
                Filter {currentViewLabel} for “{query.trim()}”
              </span>
            </CommandItem>
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
