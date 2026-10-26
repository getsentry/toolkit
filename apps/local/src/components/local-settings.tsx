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
  captureLabel?: string;
  expiresAt?: number;
};

export function LocalSettings({
  open,
  onOpenChange,
  supported,
  triggerRef,
  captureLabel,
  expiresAt,
  ...retention
}: Props) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const savedUntil =
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > 0 &&
    expiresAt <= 8.64e15
      ? new Date(expiresAt)
      : undefined;
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
            App appearance and capture history.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">Appearance</h3>
            {theme === "system" && resolvedTheme ? (
              <p aria-live="polite" className="text-xs text-muted-foreground">
                System appearance: {resolvedTheme === "dark" ? "Dark" : "Light"}
              </p>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Applies to all captures in this viewer.
          </p>
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
        <div className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-medium">History capacity</h3>
          <p className="text-xs text-muted-foreground">
            For capture: {captureLabel ?? "current receiver"}
          </p>
          {supported ? (
            <RetentionSettings {...retention} />
          ) : (
            <p className="text-sm text-muted-foreground">
              This receiver does not provide retention settings.
            </p>
          )}
        </div>
        {savedUntil ? (
          <dl className="space-y-1 border-t pt-4 text-sm">
            <dt className="font-medium">Saved until</dt>
            <dd className="text-muted-foreground">
              <time dateTime={savedUntil.toISOString()}>
                {savedUntil.toLocaleString()}
              </time>
            </dd>
          </dl>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
