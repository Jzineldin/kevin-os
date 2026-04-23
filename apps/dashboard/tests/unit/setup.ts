import '@testing-library/jest-dom';

// jsdom doesn't implement ResizeObserver / matchMedia, which cmdk +
// Radix Dialog use at mount time. These stubs let component tests render
// <CommandDialog> without a ReferenceError. Plan 03-06 Task 2.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// Radix Dialog uses hasPointerCapture / setPointerCapture / scrollIntoView
// on trigger focus management. jsdom lacks these — stub as no-ops.
if (typeof window !== 'undefined') {
  const proto = window.HTMLElement.prototype as unknown as Record<
    string,
    unknown
  >;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
}
