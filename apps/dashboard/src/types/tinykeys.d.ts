/**
 * Local ambient declaration for tinykeys 3.0.0. The package ships types at
 * dist/tinykeys.d.ts but omits a `types` condition inside its
 * package.json#exports map, so Node16 resolution can't pick them up. This
 * shim re-declares the minimal surface the dashboard uses until upstream
 * fixes the exports entry.
 */
declare module 'tinykeys' {
  export type KeyBindingMap = Record<string, (e: KeyboardEvent) => void>;

  export interface KeyBindingOptions {
    timeout?: number;
    event?: 'keydown' | 'keyup';
    capture?: boolean;
  }

  export type KeyBindingHandler = (event: KeyboardEvent) => void;

  export function tinykeys(
    target: Window | HTMLElement,
    bindings: KeyBindingMap,
    options?: KeyBindingOptions,
  ): () => void;

  export function parseKeybinding(str: string): Array<Array<string>>;
}
