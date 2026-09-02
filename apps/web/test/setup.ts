import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Server-side files run under @vitest-environment node, where there is no window
// to stub and none of this applies.
if (typeof window !== 'undefined') {
  // jsdom doesn't implement matchMedia, stub it for components using useReducedMotion
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  // jsdom doesn't implement ResizeObserver, stub it for components measuring their own container
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: ResizeObserverStub,
  });
}

afterEach(() => {
  cleanup();
});
