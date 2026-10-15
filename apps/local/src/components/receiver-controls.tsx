import {
  ChevronDown,
  Radio,
  Settings,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import type { ConnectionPresentation } from "@/lib/presentation.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

type ReceiverControlsProps = {
  connection: ConnectionPresentation;
  retainedItemCount: number;
  onClear: () => void;
  onOpenSettings?: (trigger: HTMLButtonElement) => void;
  onCloseSession?: () => void;
  isClosingSession?: boolean;
  onAddReceiver?: (trigger: HTMLButtonElement) => void;
  showStatusRole?: boolean;
};
type ReceiverAction = {
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  opensDialog?: boolean;
};

/** Mobile receiver actions share the desktop dialogs and their focus behavior. */
export function ReceiverControls({
  connection,
  retainedItemCount,
  onClear,
  onOpenSettings,
  onCloseSession,
  isClosingSession = false,
  onAddReceiver,
  showStatusRole = true,
}: ReceiverControlsProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingDialog = useRef(false);
  const actions: ReceiverAction[] = [
    ...(onAddReceiver
      ? [
          {
            label: "Add receiver",
            Icon: Radio,
            opensDialog: true,
            onClick: () => {
              if (triggerRef.current) onAddReceiver(triggerRef.current);
            },
          },
        ]
      : []),
    ...(onOpenSettings
      ? [
          {
            label: "Settings",
            Icon: Settings,
            opensDialog: true,
            onClick: () => {
              if (triggerRef.current) onOpenSettings(triggerRef.current);
            },
          },
        ]
      : []),
    {
      label: "Clear all events",
      Icon: Trash2,
      onClick: onClear,
      disabled: retainedItemCount === 0,
      destructive: true,
    },
    ...(onCloseSession
      ? [
          {
            label: "Close session",
            Icon: X,
            onClick: onCloseSession,
            disabled: isClosingSession,
            destructive: true,
          },
        ]
      : []),
  ];
  const dotClass =
    connection.tone === "success"
      ? "bg-emerald-500"
      : connection.tone === "warning"
        ? "bg-amber-500"
        : "bg-muted-foreground";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          aria-label="Receiver options"
          title={connection.label}
          className="h-8 gap-2 px-2.5"
        >
          <span
            {...(showStatusRole ? { role: "status" } : {})}
            aria-label={connection.label}
            className="flex items-center gap-2"
          >
            <span
              className={`size-2 rounded-full ${dotClass}`}
              aria-hidden="true"
            />
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {connection.label.replace(" to local receiver", "")}
            </span>
          </span>
          <ChevronDown
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Receiver actions"
        collisionPadding={12}
        className="w-48 p-1"
        onCloseAutoFocus={(event) => {
          // The destination dialog owns focus when an action opens one.
          if (openingDialog.current) event.preventDefault();
          openingDialog.current = false;
        }}
      >
        {actions.map(
          ({ label, Icon, onClick, disabled, destructive, opensDialog }) => (
            <Button
              key={label}
              type="button"
              variant="ghost"
              disabled={disabled}
              className={`h-9 w-full justify-start px-2 text-sm ${destructive ? "text-destructive hover:bg-destructive/10" : ""}`}
              onClick={() => {
                openingDialog.current = Boolean(opensDialog);
                setOpen(false);
                onClick();
              }}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </Button>
          ),
        )}
      </PopoverContent>
    </Popover>
  );
}
