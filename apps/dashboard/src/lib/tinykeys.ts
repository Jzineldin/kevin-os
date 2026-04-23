'use client';

/**
 * Tiny wrapper around `tinykeys` that re-subscribes declaratively from
 * React components. Plan 03-06 Task 1 (sidebar nav shortcuts T / I / C) +
 * Plan 03-06 Task 2 (Ctrl/⌘+K palette toggle) both consume `useKeys`.
 *
 * `isTypingInField` is the canonical guard to prevent single-key shortcuts
 * from swallowing regular typing inside the composer, login form, or any
 * future textarea. Matches the pattern documented in 03-UI-SPEC.md §Sidebar
 * ("Single-key jumps when no text input is focused").
 */
import { useEffect } from 'react';
import { tinykeys } from 'tinykeys';

export function useKeys(bindings: Record<string, (e: KeyboardEvent) => void>) {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    return tinykeys(window, bindings);
    // `bindings` identity intentionally drives re-subscription — callers
    // are expected to memoise if they need stability.
  }, [bindings]);
}

export function isTypingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}
