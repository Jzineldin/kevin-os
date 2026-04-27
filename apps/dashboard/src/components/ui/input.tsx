import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Input — v4 polish pass.
 *
 * - Solid surface-2 background (not transparent) so inputs read as
 *   tactile objects on the surface-1 panel they sit inside.
 * - Border subtle; hover lifts to border-hover; focus sets the ring
 *   to the v4 priority tint with a `ring-2` (not ring-3 bloom).
 * - Placeholder reduced to text-4 for calmer empty state.
 * - Disabled state quieter via opacity-45 (matches Button).
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border px-3 py-1 text-[13px] outline-none",
        "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] text-[color:var(--color-text)]",
        "placeholder:text-[color:var(--color-text-4)]",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-[color:var(--color-text)]",
        "transition-[border-color,box-shadow] duration-[var(--transition-fast)] ease-[var(--ease)]",
        "hover:border-[color:var(--color-border-hover)]",
        "focus-visible:border-[color:var(--color-sect-priority)] focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--color-sect-priority)_30%,transparent)]",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-[color:color-mix(in_srgb,var(--color-danger)_25%,transparent)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
