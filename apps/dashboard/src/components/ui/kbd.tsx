import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `kbd` — keyboard shortcut hint, used throughout the app per 03-UI-SPEC.md §C.
 *
 * shadcn does not ship a `kbd` component; we author it here to match the
 * existing shadcn convention (React.forwardRef, className merged via cn()).
 *
 * Styling intentionally leans on our @theme tokens (--color-surface-2,
 * --color-border, --color-text-3, --radius-sm, --text-xs, --font-mono) so
 * shortcut hints match the calm-dark palette from TFOS-ui.html.
 */
const Kbd = React.forwardRef<
  HTMLElement,
  React.HTMLAttributes<HTMLElement>
>(({ className, ...props }, ref) => (
  <kbd
    ref={ref}
    className={cn(
      "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1 font-mono text-xs leading-none",
      "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] text-[color:var(--color-text-3)]",
      className
    )}
    {...props}
  />
));
Kbd.displayName = "Kbd";

export { Kbd };
