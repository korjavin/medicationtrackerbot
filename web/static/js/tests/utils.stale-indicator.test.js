import { describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('showStaleIndicator / hideStaleIndicator', () => {
  it('creates a .stale-dot element inside the container and makes it visible', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const container = document.createElement('div');
      container.style.position = 'relative';
      document.body.appendChild(container);

      window.showStaleIndicator(container, new Date());

      const dot = container.querySelector('.stale-dot');
      expect(dot).not.toBeNull();
      expect(dot.classList.contains('visible')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('sets data-cache-age attribute with a human-readable age string', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      window.showStaleIndicator(container, twoHoursAgo);

      const dot = container.querySelector('.stale-dot');
      expect(dot.getAttribute('data-cache-age')).toContain('2h ago');
    } finally {
      cleanup();
    }
  });

  it('reuses existing .stale-dot element on repeated calls', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);

      window.showStaleIndicator(container, new Date());
      window.showStaleIndicator(container, new Date());

      expect(container.querySelectorAll('.stale-dot').length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('hideStaleIndicator removes the visible class from the dot', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);

      window.showStaleIndicator(container, new Date());
      window.hideStaleIndicator(container);

      const dot = container.querySelector('.stale-dot');
      expect(dot.classList.contains('visible')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('hideStaleIndicator is a no-op when no dot exists', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);

      expect(() => window.hideStaleIndicator(container)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('showStaleIndicator is a no-op when containerEl is null', () => {
    const { window, cleanup } = loadFrontendEnv();
    try {
      expect(() => window.showStaleIndicator(null, new Date())).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('formats age as minutes for recent cache', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);

      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
      window.showStaleIndicator(container, thirtyMinsAgo);

      const dot = container.querySelector('.stale-dot');
      expect(dot.getAttribute('data-cache-age')).toContain('30m ago');
    } finally {
      cleanup();
    }
  });

  it('formats age as days for old cache', () => {
    const { window, document, cleanup } = loadFrontendEnv();
    try {
      const container = document.createElement('div');
      document.body.appendChild(container);

      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      window.showStaleIndicator(container, threeDaysAgo);

      const dot = container.querySelector('.stale-dot');
      expect(dot.getAttribute('data-cache-age')).toContain('3d ago');
    } finally {
      cleanup();
    }
  });
});
