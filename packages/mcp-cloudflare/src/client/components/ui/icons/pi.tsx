import { cn } from "@/client/lib/utils";

export function PiIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 560 560"
      className={cn("fill-current size-4", className)}
      aria-hidden="true"
    >
      <path d="M411.25 280H280V148.75H17.5V17.5H411.25Z" />
      <path d="M542.5 542.5H411.25V280H542.5Z" />
      <path d="M148.75 542.5H17.5V148.75H148.75V280H280V411.25H148.75Z" />
    </svg>
  );
}
