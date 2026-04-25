'use client';

/**
 * Shared React Context for the command palette open/close surface. Split
 * into its own module so Task 1 (sidebar) can consume `useCommandPalette`
 * without pulling the cmdk Dialog (and its transitive `cmdk`/Radix bundle)
 * into the server-rendered sidebar tree. Task 2's CommandPalette provider
 * is the sole producer; every other component is a consumer.
 */
import { createContext, useContext } from 'react';

export type CommandPaletteApi = {
  open: () => void;
  close: () => void;
  toggle: () => void;
};

export const CommandPaletteCtx = createContext<CommandPaletteApi>({
  open: () => {},
  close: () => {},
  toggle: () => {},
});

export function useCommandPalette(): CommandPaletteApi {
  return useContext(CommandPaletteCtx);
}
