import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Textarea — v4 polish pass.
 *
 * Mirrors Input's treatment: solid surface-2 bg, priority focus ring
 * (2px, not 3), placeholder in text-4. `field-sizing-content` retained
 * so textareas grow with content rather than requiring JS resize.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border px-3 py-2 text-[13px] outline-none",
        "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] text-[color:var(--color-text)]",
        "placeholder:text-[color:var(--color-text-4)]",
        "transition-[border-color,box-shadow] duration-[var(--transition-fast)] ease-[var(--ease)]",
        "hover:border-[color:var(--color-border-hover)]",
        "focus-visible:border-[color:var(--color-sect-priority)] focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--color-sect-priority)_30%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-45",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-[color:color-mix(in_srgb,var(--color-danger)_25%,transparent)]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
