'use client';

/**
 * CommandPaletteProvider — stub provider for Task 1 of Plan 03-06. Exposes
 * `open` / `close` / `toggle` via the shared CommandPaletteCtx so the
 * sidebar + topbar can wire their triggers before Task 2 lands the actual
 * cmdk Dialog. Task 2 replaces the body of this file with the full palette
 * UI (entities / views / actions + ⌘K keybind).
 */
import { useMemo, useState } from 'react';
import {
  CommandPaletteCtx,
  type CommandPaletteApi,
} from './palette-context';

export function CommandPaletteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Keep the setter around so Task 2 can swap the file in-place without
  // breaking state shape. The `_isOpen` value is intentionally unread at
  // this stage — the provider is a hook-surface stub only.
  const [, setOpen] = useState(false);

  const api = useMemo<CommandPaletteApi>(
    () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
    }),
    [],
  );

  return (
    <CommandPaletteCtx.Provider value={api}>
      {children}
    </CommandPaletteCtx.Provider>
  );
}

export { useCommandPalette } from './palette-context';
