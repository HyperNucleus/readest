import { describe, expect, it } from 'vitest';

describe('browser storage environment', () => {
  it.each(['localStorage', 'sessionStorage'] as const)('provides jsdom %s', (name) => {
    const storage = window[name];
    expect(storage).toBeInstanceOf(window.Storage);
    const key = 'browser-storage-regression';
    try {
      storage.setItem(key, 'value');
      expect(storage.getItem(key)).toBe('value');
      expect(globalThis[name].getItem(key)).toBe('value');
    } finally {
      storage.removeItem(key);
    }
  });
});
