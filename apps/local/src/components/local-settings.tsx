import type { RefObject } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "./ui/button.tsx";
import { RetentionSettings } from "./retention-settings.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";

const THEME_OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

type Props = {
  triggerRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  streamUrl: string;
  limit: number;
  count: number;
  editable: boolean;
  supported: boolean;
  unavailableReason?: string;
};

export function LocalSettings({
  open,
  onOpenChange,
  supported,
  triggerRef,
  ...retention
}: Props) {
  const { theme, setTheme } = useTheme();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          if (triggerRef.current?.isConnected) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Customize viewer appearance and manage session retention.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-sm font-medium">Appearance</p>
          <div
            role="group"
            aria-label="Color theme"
            className="grid grid-cols-3 gap-2"
          >
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <Button
                key={value}
                type="button"
                className="min-w-0 gap-1 px-1 sm:gap-2 sm:px-4"
                variant={theme === value ? "default" : "outline"}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div className="border-t pt-4">
          {supported ? (
            <RetentionSettings {...retention} />
          ) : (
            <p className="text-sm text-muted-foreground">
              This receiver does not provide retention settings.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
