import {
  ChevronDown,
  Radio,
  Settings,
  Trash2,
  Eraser,
  X,
  Unplug,
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
  onDeleteCapturedEvents?: (trigger: HTMLButtonElement) => void;
  onDisconnect?: () => void;
  isClearing?: boolean;
  onOpenSettings?: (trigger: HTMLButtonElement) => void;
  onCloseSession?: () => void;
  isClosingSession?: boolean;
  onAddReceiver?: (trigger: HTMLButtonElement) => void;
  showStatusRole?: boolean;
};
type ReceiverAction = {
  label: string;
  Icon: LucideIcon;
  onClick?: () => void;
  onOpenDialog?: (trigger: HTMLButtonElement) => void;
  disabled?: boolean;
  destructive?: boolean;
};

/** Mobile receiver actions share the desktop dialogs and their focus behavior. */
export function ReceiverControls({
  connection,
  retainedItemCount,
  onClear,
  onDeleteCapturedEvents,
  onDisconnect,
  isClearing = false,
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
            label: "Switch receiver",
            Icon: Radio,
            onOpenDialog: onAddReceiver,
          },
        ]
      : []),
    ...(onOpenSettings
      ? [
          {
            label: "Settings",
            Icon: Settings,
            onOpenDialog: onOpenSettings,
          },
        ]
      : []),
    {
      label: "Clear view",
      Icon: Eraser,
      onClick: onClear,
      disabled: retainedItemCount === 0 || isClearing,
    },
    ...(onDeleteCapturedEvents
      ? [
          {
            label: "Delete captured events",
            Icon: Trash2,
            destructive: true,
            disabled: isClearing,
            onOpenDialog: onDeleteCapturedEvents,
          },
        ]
      : []),
    ...(onCloseSession
      ? [
          {
            label: "Stop capture",
            Icon: X,
            onClick: onCloseSession,
            disabled: isClosingSession || isClearing,
            destructive: true,
          },
        ]
      : []),
    ...(onDisconnect
      ? [{ label: "Disconnect viewer", Icon: Unplug, onClick: onDisconnect }]
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
          aria-label="Capture actions"
          title={connection.label}
          className="h-8 gap-2 px-2.5"
        >
          {showStatusRole ? (
            <span
              role="status"
              aria-label={connection.label}
              className={`size-2 rounded-full ${dotClass}`}
            />
          ) : null}
          <span>Capture actions</span>
          <ChevronDown
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Capture actions"
        collisionPadding={12}
        className="w-56 max-w-[calc(100vw-1.5rem)] p-1"
        onCloseAutoFocus={(event) => {
          // The destination dialog owns focus when an action opens one.
          if (openingDialog.current) event.preventDefault();
          openingDialog.current = false;
        }}
      >
        {actions.map(
          ({ label, Icon, onClick, disabled, destructive, onOpenDialog }) => (
            <Button
              key={label}
              type="button"
              variant="ghost"
              disabled={disabled}
              className={`h-9 w-full justify-start px-2 text-sm ${destructive ? "text-destructive hover:bg-destructive/10" : ""}`}
              onClick={() => {
                openingDialog.current = Boolean(onOpenDialog);
                setOpen(false);
                if (onOpenDialog && triggerRef.current) {
                  onOpenDialog(triggerRef.current);
                } else {
                  onClick?.();
                }
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
