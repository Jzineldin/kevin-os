'use client';

/**
 * CommandPaletteProvider + cmdk Dialog.
 *
 * Per 03-UI-SPEC §"View 5 — Global Command Palette":
 *   - Opens on ⌘K (mac) or Ctrl+K (win/linux). Esc closes. ⌘K again toggles.
 *   - Three sections: Entities, Views, Actions.
 *   - Entities are fetched on first open from /api/palette-entities (which
 *     passes through to dashboard-api /entities/list). Cached in component
 *     state; never re-fetched while the provider is mounted.
 *   - Selecting an entity → /entities/[id]. Selecting a view → view route.
 *     Logout → POST /api/auth/logout then router.push('/login').
 *   - Empty state copy is UI-SPEC Copy Table verbatim:
 *       "No match. Type to search entities and commands."
 *
 * cmdk performs its own string-match filtering via the <CommandInput>.
 * Per CONTEXT.md D-10 we use the default "string contains" behaviour only
 * (no NL routing — that's Phase 6 AGT-04).
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import {
  CommandPaletteCtx,
  type CommandPaletteApi,
} from './palette-context';
import type { PaletteEntity } from './palette-root';

async function fetchPaletteEntities(): Promise<PaletteEntity[]> {
  try {
    const r = await fetch('/api/palette-entities', {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!r.ok) return [];
    const body = (await r.json()) as { entities?: PaletteEntity[] };
    return body.entities ?? [];
  } catch {
    return [];
  }
}

export function CommandPaletteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isOpen, setOpen] = useState(false);
  const [entities, setEntities] = useState<PaletteEntity[]>([]);
  const [entitiesLoaded, setEntitiesLoaded] = useState(false);
  const router = useRouter();

  // ⌘K / Ctrl+K toggles the palette. Works regardless of where focus is —
  // mirroring the UI-SPEC rule "⌘K again toggles". Esc is handled by the
  // Radix Dialog primitive.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Lazy-load entities only after first open; cache for the rest of the
  // session. Threat T-3-06-04 mitigation (no per-open re-fetch).
  useEffect(() => {
    if (!isOpen || entitiesLoaded) return;
    let cancelled = false;
    fetchPaletteEntities().then((rows) => {
      if (cancelled) return;
      setEntities(rows);
      setEntitiesLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, entitiesLoaded]);

  const api = useMemo<CommandPaletteApi>(
    () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
    }),
    [],
  );

  async function handleLogout() {
    setOpen(false);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* noop */
    }
    router.push('/login');
  }

  return (
    <CommandPaletteCtx.Provider value={api}>
      {children}
      <CommandDialog
        open={isOpen}
        onOpenChange={setOpen}
        title="Command Palette"
        description="Search entities, views, and actions."
      >
        <Command label="Command Palette">
        <CommandInput placeholder="Search or type a command…" />
        <CommandList>
          <CommandEmpty>
            No match. Type to search entities and commands.
          </CommandEmpty>

          {entities.length > 0 && (
            <CommandGroup heading="Entities">
              {entities.map((e) => (
                <CommandItem
                  key={e.id}
                  value={`${e.name} ${e.type} ${e.bolag ?? ''}`}
                  onSelect={() => {
                    setOpen(false);
                    router.push(`/entities/${e.id}` as never);
                  }}
                >
                  <span className="flex-1">{e.name}</span>
                  <span className="text-[11px] text-[color:var(--color-text-3)]">
                    {e.type}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          <CommandGroup heading="Views">
            <CommandItem
              value="Today"
              onSelect={() => {
                setOpen(false);
                router.push('/today' as never);
              }}
            >
              Today
            </CommandItem>
            <CommandItem
              value="Inbox"
              onSelect={() => {
                setOpen(false);
                router.push('/inbox' as never);
              }}
            >
              Inbox
            </CommandItem>
            <CommandItem
              value="Calendar"
              onSelect={() => {
                setOpen(false);
                router.push('/calendar' as never);
              }}
            >
              Calendar
            </CommandItem>
            <CommandItem
              value="Settings"
              onSelect={() => {
                setOpen(false);
                router.push('/settings' as never);
              }}
            >
              Settings
            </CommandItem>
          </CommandGroup>

          <CommandGroup heading="Actions">
            <CommandItem value="Logout" onSelect={handleLogout}>
              Logout
            </CommandItem>
          </CommandGroup>
        </CommandList>
        </Command>
      </CommandDialog>
    </CommandPaletteCtx.Provider>
  );
}

export { useCommandPalette } from './palette-context';
