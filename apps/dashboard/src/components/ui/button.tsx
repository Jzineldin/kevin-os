import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Button — v4 polish pass.
 *
 * Changes vs. original shadcn default:
 * - `default` (primary) carries the v4 primary-shadow token:
 *   inner 1px highlight + outer glow in the section-priority tint,
 *   so the button looks lifted against surface-1. Hover darkens
 *   via `bg-primary/92` rather than the aggressive `/80`.
 * - `outline` uses surface-2 by default (not transparent) so it
 *   reads as an interactive chip against surface-1 panels, rather
 *   than ghosting into the background.
 * - `ghost` stays transparent; hover to surface-2 for parity.
 * - Focus ring unified to `ring-2` (was ring-3 bloom) using the v4
 *   global focus system (:focus-visible → outline). Tailwind's
 *   ring stays for aria-invalid / destructive.
 * - Sizes retuned: `default` 32px (was 32 but with ambiguous
 *   radius), all sizes use `radius-md` (no per-size override) for
 *   consistency; icon buttons still use `size-8/7/9`.
 * - `active` translate-y nudged to 0.5px for a tactile press
 *   without bouncing around.
 */
const buttonVariants = cva(
  // Base: no ring bloom; shadow-btn inset highlight; font-weight 600;
  // svg nudge keeps lucide icons aligned with mono kbd-style text.
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent text-sm font-semibold whitespace-nowrap outline-none select-none transition-[background,border-color,box-shadow,color] duration-[var(--transition-fast)] ease-[var(--ease)] active:not-aria-[haspopup]:translate-y-[0.5px] disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[var(--shadow-btn-primary)] hover:bg-primary/92 active:bg-primary/88",
        outline:
          "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] text-[color:var(--color-text-2)] shadow-[var(--shadow-btn)] hover:bg-[color:var(--color-surface-hover)] hover:text-[color:var(--color-text)] hover:border-[color:var(--color-border-hover)] aria-expanded:bg-[color:var(--color-surface-hover)]",
        secondary:
          "bg-[color:var(--color-surface-2)] text-[color:var(--color-text-2)] shadow-[var(--shadow-btn)] hover:bg-[color:var(--color-surface-hover)] hover:text-[color:var(--color-text)] aria-expanded:bg-[color:var(--color-surface-hover)]",
        ghost:
          "text-[color:var(--color-text-2)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-text)] aria-expanded:bg-[color:var(--color-surface-2)] aria-expanded:text-[color:var(--color-text)]",
        destructive:
          "bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)] text-[color:var(--color-danger)] border-[color:color-mix(in_srgb,var(--color-danger)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-danger)_25%,transparent)] focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--color-danger)_40%,transparent)]",
        link: "text-[color:var(--color-sect-priority)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 text-[13px]",
        xs: "h-6 gap-1 px-2 text-[11px] font-semibold [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-[12px]",
        lg: "h-9 px-3.5 text-[13px]",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
