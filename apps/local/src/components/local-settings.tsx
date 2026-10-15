import type { RefObject } from "react";
import { RetentionSettings } from "./retention-settings.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
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
            Manage retention for the selected session.
          </DialogDescription>
        </DialogHeader>
        {supported ? (
          <RetentionSettings {...retention} />
        ) : (
          <p className="text-sm text-muted-foreground">
            This receiver does not provide retention settings.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
