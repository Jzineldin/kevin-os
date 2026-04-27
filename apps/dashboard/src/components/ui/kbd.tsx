import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `kbd` — keyboard shortcut hint, v4 polish pass.
 *
 * Tactile look: surface-1 pill (darker than surrounding surface-2),
 * 1px border in border-hover, inset highlight + 1px drop shadow via
 * the reusable `.kbd-tactile` class from globals.css. Font tightened
 * to mono-10 with +1 letter-spacing for a stencilled-key feel.
 */
const Kbd = React.forwardRef<
  HTMLElement,
  React.HTMLAttributes<HTMLElement>
>(({ className, ...props }, ref) => (
  <kbd
    ref={ref}
    data-slot="kbd"
    className={cn(
      "kbd-tactile",
      "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border px-[5px] font-mono text-[10px] leading-none font-medium",
      "border-[color:var(--color-border-hover)] bg-[color:var(--color-surface-1)] text-[color:var(--color-text-3)]",
      className
    )}
    {...props}
  />
));
Kbd.displayName = "Kbd";

export { Kbd };
