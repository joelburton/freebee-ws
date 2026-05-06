import "@testing-library/jest-dom/vitest";

// jsdom's storage stubs lack the actual Storage methods; supply an
// in-memory polyfill so components can read/write during tests.
class MemoryStorage {
  constructor() {
    this.store = {};
  }
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }
  setItem(key, value) {
    this.store[key] = String(value);
  }
  removeItem(key) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
  key(i) {
    return Object.keys(this.store)[i] ?? null;
  }
  get length() {
    return Object.keys(this.store).length;
  }
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  // jsdom doesn't implement matchMedia. Components that branch on
  // viewport (e.g., Chat's "skip focus on phone" behavior) call it on
  // user interaction; default to a non-matching result so desktop-path
  // assertions hold.
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false,
      media: "",
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
}
