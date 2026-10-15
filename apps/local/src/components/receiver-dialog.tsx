import type { RefObject } from "react";
import {
  ConnectionForm,
  type ConnectionFormProps,
} from "./connection-landing.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";

export function ReceiverDialog({
  open,
  onOpenChange,
  triggerRef,
  ...form
}: ConnectionFormProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          if (triggerRef.current?.isConnected) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Add receiver</DialogTitle>
          <DialogDescription>
            Your current feed stays open while you connect.
          </DialogDescription>
        </DialogHeader>
        <ConnectionForm {...form} />
      </DialogContent>
    </Dialog>
  );
}
